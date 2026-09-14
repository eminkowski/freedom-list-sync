import type { BrowserContext } from "playwright";

import { FREEDOM_ORIGIN } from "./auth.js";
import { readCsrfToken } from "./csrf.js";
import {
  FreedomAuthenticationError,
  FreedomHttpError,
  FreedomRequestTimeoutError,
  FreedomValidationError,
  isAuthenticationStatus,
  isRetryableFreedomStatus,
} from "./errors.js";
import {
  FREEDOM_REQUEST_TIMEOUT_MS,
  pathFromUrl,
  runFreedomRequest,
} from "./request.js";
import type { AddDomainsResult, FreedomWriter } from "./writer.js";
import type { Logger } from "../utils/logger.js";
import { DEFAULT_BACKOFF_MS, withBackoff } from "../utils/sleep.js";

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 500;

export interface FreedomApiResponse {
  status(): number;
  ok(): boolean;
  headers(): Record<string, string>;
  text(): Promise<string>;
}

export interface FreedomApiRequest {
  patch(
    url: string,
    options: {
      data?: unknown;
      headers?: Record<string, string>;
      failOnStatusCode?: boolean;
      timeout?: number;
    },
  ): Promise<FreedomApiResponse>;
}

export type CsrfProvider = (forceRefresh?: boolean) => Promise<string>;

export interface HttpFreedomWriterOptions {
  request: FreedomApiRequest;
  /** Required for live Freedom writes. Tests may supply a fixed token provider. */
  csrfProvider: CsrfProvider;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  logger?: Logger;
  requestTimeoutMs?: number;
}

export function buildAddDomainsPayload(domains: string[]): {
  custom_domains_to_add: string[];
} {
  return {
    custom_domains_to_add: domains,
  };
}

export function buildAddDomainsHeaders(csrfToken: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: FREEDOM_ORIGIN,
    referer: `${FREEDOM_ORIGIN}/`,
    "x-csrf-token": csrfToken,
    "x-requested-with": "XMLHttpRequest",
  };
}

/**
 * Deduplicate while preserving first-seen order.
 * Domains must already be normalized upstream.
 */
export function prepareDomainsForWrite(domains: readonly string[]): string[] {
  if (domains.length === 0) {
    throw new FreedomValidationError("Cannot add an empty domain batch.");
  }

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const domain of domains) {
    if (typeof domain !== "string" || domain.trim() === "") {
      throw new FreedomValidationError("Writer received an empty domain entry.");
    }
    if (domain !== domain.trim().toLowerCase()) {
      throw new FreedomValidationError(
        `Writer received a non-normalized domain: ${JSON.stringify(domain)}`,
      );
    }
    if (domain.includes(" ") || domain.includes("/") || domain.includes(":")) {
      throw new FreedomValidationError(
        `Writer received a malformed domain: ${JSON.stringify(domain)}`,
      );
    }
    if (!seen.has(domain)) {
      seen.add(domain);
      unique.push(domain);
    }
  }

  return unique;
}

export function assertValidListId(listId: number): void {
  if (!Number.isInteger(listId) || listId <= 0) {
    throw new FreedomValidationError(`Invalid Freedom list ID: ${String(listId)}`);
  }
}

export function filterListsUrl(listId: number): string {
  assertValidListId(listId);
  return `${FREEDOM_ORIGIN}/filter_lists/${listId}`;
}

export function parsePatchResponse(
  listId: number,
  requested: number,
  payload: unknown,
  countBefore?: number,
): AddDomainsResult {
  if (!payload || typeof payload !== "object") {
    throw new FreedomValidationError("Freedom PATCH response was not a JSON object.");
  }

  const record = payload as Record<string, unknown>;
  const responseId = asOptionalNumber(record.id);
  if (responseId !== undefined && responseId !== listId) {
    throw new FreedomValidationError(
      `Freedom PATCH response list id ${responseId} did not match target ${listId}.`,
    );
  }

  const countAfter = asOptionalNumber(record.count_websites);
  const result: AddDomainsResult = { requested };

  if (countBefore !== undefined) {
    result.countBefore = countBefore;
  }
  if (countAfter !== undefined) {
    result.countAfter = countAfter;
    if (countBefore !== undefined) {
      result.addedCount = Math.max(0, countAfter - countBefore);
    }
  }

  return result;
}

export class HttpFreedomWriter implements FreedomWriter {
  private readonly request: FreedomApiRequest;
  private readonly csrfProvider: CsrfProvider;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly backoffMs: readonly number[];
  private readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  private readonly logger?: Logger;
  private readonly requestTimeoutMs: number;
  private cachedCsrfToken: string | null = null;

  constructor(options: HttpFreedomWriterOptions) {
    this.request = options.request;
    this.csrfProvider = options.csrfProvider;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? FREEDOM_REQUEST_TIMEOUT_MS;
    if (options.sleep) {
      this.sleep = options.sleep;
    }
    if (options.onRetry) {
      this.onRetry = options.onRetry;
    }
    if (options.logger) {
      this.logger = options.logger;
    }
  }

  static fromContext(
    context: BrowserContext,
    options: Omit<HttpFreedomWriterOptions, "request" | "csrfProvider"> = {},
  ): HttpFreedomWriter {
    return new HttpFreedomWriter({
      request: context.request,
      csrfProvider: async (forceRefresh = false) =>
        readCsrfToken(context, { forceNavigate: forceRefresh }),
      ...options,
    });
  }

  async addDomains(listId: number, domains: string[]): Promise<AddDomainsResult> {
    const prepared = prepareDomainsForWrite(domains);

    // Known transient HTTP statuses may retry. Timeouts must NOT — outcome is unknown.
    return withBackoff(
      async () => this.patchWithCsrfRefresh(listId, prepared),
      {
        delaysMs: this.backoffMs,
        shouldRetry: (error) => isRetryableWriterError(error),
        ...(this.sleep ? { sleep: this.sleep } : {}),
        ...(this.onRetry ? { onRetry: this.onRetry } : {}),
      },
    );
  }

  private async patchWithCsrfRefresh(
    listId: number,
    domains: string[],
  ): Promise<AddDomainsResult> {
    let refreshed = false;

    while (true) {
      const csrfToken = await this.getCsrfToken(refreshed);
      try {
        return await this.patchOnce(listId, domains, csrfToken);
      } catch (error) {
        if (error instanceof FreedomAuthenticationError && !refreshed) {
          this.cachedCsrfToken = null;
          refreshed = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async getCsrfToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.cachedCsrfToken) {
      return this.cachedCsrfToken;
    }
    const token = await this.csrfProvider(forceRefresh);
    this.cachedCsrfToken = token;
    return token;
  }

  private async patchOnce(
    listId: number,
    domains: string[],
    csrfToken: string,
  ): Promise<AddDomainsResult> {
    const url = filterListsUrl(listId);
    const path = pathFromUrl(url);

    const response = await runFreedomRequest(
      (timeoutMs) =>
        this.request.patch(url, {
          data: buildAddDomainsPayload(domains),
          headers: buildAddDomainsHeaders(csrfToken),
          failOnStatusCode: false,
          timeout: timeoutMs,
        }),
      {
        method: "PATCH",
        path,
        timeoutMs: this.requestTimeoutMs,
        ...(this.logger ? { logger: this.logger } : {}),
      },
    );

    return interpretPatchResponse(listId, domains.length, response);
  }
}

export async function interpretPatchResponse(
  listId: number,
  requested: number,
  response: FreedomApiResponse,
  countBefore?: number,
): Promise<AddDomainsResult> {
  const status = response.status();

  if (isAuthenticationStatus(status)) {
    throw new FreedomAuthenticationError();
  }

  const text = await response.text();
  const contentType = response.headers()["content-type"] ?? "";

  if (!response.ok()) {
    if (isRetryableFreedomStatus(status)) {
      throw new FreedomHttpError(status, text.slice(0, 200));
    }
    if (status === 400 || status === 404 || status === 422) {
      throw new FreedomValidationError(
        `Freedom rejected the batch (HTTP ${status}): ${text.slice(0, 200)}`,
      );
    }
    throw new FreedomHttpError(status, text.slice(0, 200));
  }

  if (!contentType.includes("application/json") && !text.trimStart().startsWith("{")) {
    if (looksLikeLoginHtml(text)) {
      throw new FreedomAuthenticationError();
    }
    throw new FreedomValidationError(
      `Unexpected Freedom PATCH response content-type: ${contentType || "unknown"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (looksLikeLoginHtml(text)) {
      throw new FreedomAuthenticationError();
    }
    throw new FreedomValidationError("Freedom PATCH response was not valid JSON.");
  }

  return parsePatchResponse(listId, requested, parsed, countBefore);
}

/**
 * Transient HTTP responses may retry. Timeouts must not — write outcome is unknown.
 */
export function isRetryableWriterError(error: unknown): boolean {
  if (error instanceof FreedomRequestTimeoutError) {
    return false;
  }
  if (error instanceof FreedomAuthenticationError) {
    return false;
  }
  if (error instanceof FreedomValidationError) {
    return false;
  }
  if (error instanceof FreedomHttpError) {
    return isRetryableFreedomStatus(error.status);
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const maybe = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
  };

  const status = maybe.status ?? maybe.statusCode;
  if (typeof status === "number" && isRetryableFreedomStatus(status)) {
    return true;
  }

  const code = maybe.code;
  if (
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  // Do not treat generic "timeout" strings as retryable write errors.
  const message = maybe.message?.toLowerCase() ?? "";
  return message.includes("temporarily unavailable") || message.includes("rate limit");
}

function looksLikeLoginHtml(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("sign in") || lower.includes("log in") || lower.includes("<!doctype html")
  );
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
