import type { BrowserContext } from "playwright";

import { FREEDOM_FILTER_LISTS_URL, FREEDOM_ORIGIN } from "./auth.js";
import { normalizeFilterListPayload } from "./client.js";
import { readCsrfToken } from "./csrf.js";
import {
  FreedomAuthenticationError,
  FreedomHttpError,
  FreedomValidationError,
  isAuthenticationStatus,
  isRetryableFreedomStatus,
} from "./errors.js";
import {
  buildAddDomainsHeaders,
  isRetryableWriterError,
} from "./http-writer.js";
import {
  FREEDOM_REQUEST_TIMEOUT_MS,
  pathFromUrl,
  runFreedomRequest,
} from "./request.js";
import type { FreedomFilterList } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { DEFAULT_BACKOFF_MS, withBackoff } from "../utils/sleep.js";

/**
 * Thrown by UnsupportedFreedomListCreator when automatic creation is disabled.
 */
export class FilterListCreationUnsupportedError extends Error {
  constructor() {
    super(
      "Automatic Freedom filter-list creation is disabled in this context. " +
        "Use HttpFreedomListCreator for live sync, or create the list manually.",
    );
    this.name = "FilterListCreationUnsupportedError";
  }
}

export interface FreedomListCreator {
  /**
   * Create an empty Freedom custom blocklist with the given exact name.
   * Observed live: POST /filter_lists/ with `{ name }` → HTTP 201 + list object.
   */
  createFilterList(name: string): Promise<FreedomFilterList>;
}

/**
 * Placeholder that refuses to create lists (unit tests / explicit opt-out).
 */
export class UnsupportedFreedomListCreator implements FreedomListCreator {
  async createFilterList(_name: string): Promise<FreedomFilterList> {
    throw new FilterListCreationUnsupportedError();
  }
}

/** Empty list shape used after a successful create before domains are added. */
export function emptyFilterList(id: number, name: string): FreedomFilterList {
  return {
    id,
    name,
    count_websites: 0,
    custom_filters: [],
  };
}

export function buildCreateFilterListPayload(name: string): { name: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new FreedomValidationError("Cannot create a Freedom filter list with an empty name.");
  }
  return { name: trimmed };
}

/** Same CSRF/XHR headers as PATCH domain writes. */
export function buildCreateFilterListHeaders(csrfToken: string): Record<string, string> {
  return buildAddDomainsHeaders(csrfToken);
}

export const FREEDOM_CREATE_FILTER_LIST_URL = `${FREEDOM_ORIGIN}/filter_lists/`;

export interface FreedomCreateApiRequest {
  post(
    url: string,
    options: {
      data?: unknown;
      headers?: Record<string, string>;
      failOnStatusCode?: boolean;
      timeout?: number;
    },
  ): Promise<{
    status(): number;
    ok(): boolean;
    headers(): Record<string, string>;
    text(): Promise<string>;
  }>;
}

export type CreateCsrfProvider = (forceRefresh?: boolean) => Promise<string>;

export interface HttpFreedomListCreatorOptions {
  request: FreedomCreateApiRequest;
  csrfProvider: CreateCsrfProvider;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  logger?: Logger;
  requestTimeoutMs?: number;
}

/**
 * Creates Freedom custom blocklists via the observed live API:
 * POST https://freedom.to/filter_lists/  body `{ "name": "..." }`  → 201
 */
export class HttpFreedomListCreator implements FreedomListCreator {
  private readonly request: FreedomCreateApiRequest;
  private readonly csrfProvider: CreateCsrfProvider;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly backoffMs: readonly number[];
  private readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  private readonly logger?: Logger;
  private readonly requestTimeoutMs: number;
  private cachedCsrfToken: string | null = null;

  constructor(options: HttpFreedomListCreatorOptions) {
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
    options: Omit<HttpFreedomListCreatorOptions, "request" | "csrfProvider"> = {},
  ): HttpFreedomListCreator {
    return new HttpFreedomListCreator({
      request: context.request,
      csrfProvider: async (forceRefresh = false) =>
        readCsrfToken(context, { forceNavigate: forceRefresh }),
      ...options,
    });
  }

  async createFilterList(name: string): Promise<FreedomFilterList> {
    const payload = buildCreateFilterListPayload(name);

    return withBackoff(
      async () => this.postWithCsrfRefresh(payload),
      {
        delaysMs: this.backoffMs,
        shouldRetry: (error) => isRetryableWriterError(error),
        ...(this.sleep ? { sleep: this.sleep } : {}),
        ...(this.onRetry ? { onRetry: this.onRetry } : {}),
      },
    );
  }

  private async postWithCsrfRefresh(payload: { name: string }): Promise<FreedomFilterList> {
    let refreshed = false;

    while (true) {
      const csrfToken = await this.getCsrfToken(refreshed);
      try {
        return await this.postOnce(payload, csrfToken);
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

  private async postOnce(
    payload: { name: string },
    csrfToken: string,
  ): Promise<FreedomFilterList> {
    const url = FREEDOM_FILTER_LISTS_URL;
    const path = pathFromUrl(url);

    const response = await runFreedomRequest(
      (timeoutMs) =>
        this.request.post(url, {
          data: payload,
          headers: buildCreateFilterListHeaders(csrfToken),
          failOnStatusCode: false,
          timeout: timeoutMs,
        }),
      {
        method: "POST",
        path,
        timeoutMs: this.requestTimeoutMs,
        ...(this.logger ? { logger: this.logger } : {}),
      },
    );

    return interpretCreateFilterListResponse(payload.name, response);
  }
}

export async function interpretCreateFilterListResponse(
  requestedName: string,
  response: {
    status(): number;
    ok(): boolean;
    headers(): Record<string, string>;
    text(): Promise<string>;
  },
): Promise<FreedomFilterList> {
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
        `Freedom rejected list creation (HTTP ${status}): ${text.slice(0, 200)}`,
      );
    }
    throw new FreedomHttpError(status, text.slice(0, 200));
  }

  if (!contentType.includes("application/json") && !text.trimStart().startsWith("{")) {
    const lower = text.toLowerCase();
    if (lower.includes("sign in") || lower.includes("log in")) {
      throw new FreedomAuthenticationError();
    }
    throw new FreedomValidationError(
      `Unexpected Freedom create response content-type: ${contentType || "unknown"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FreedomValidationError("Freedom create response was not valid JSON.");
  }

  const list = normalizeFilterListPayload(parsed);
  if (list.name.trim() !== requestedName.trim()) {
    throw new FreedomValidationError(
      `Freedom created list named ${JSON.stringify(list.name)} ` +
        `but requested ${JSON.stringify(requestedName)}.`,
    );
  }

  return list;
}
