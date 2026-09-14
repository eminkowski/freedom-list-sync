import { mkdir } from "node:fs/promises";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
} from "playwright";

import {
  FREEDOM_FILTER_LISTS_URL,
  FreedomAuthExpiredError,
  FreedomAuthFileInvalidError,
  FreedomAuthUnavailableError,
  authStateExists,
  getProfileDir,
  legacyProfileExists,
  loadAuthStorageState,
  touchAuthValidated,
  type FreedomAuthStatus,
} from "./auth.js";
import {
  FreedomRequestTimeoutError,
  FreedomFilterListsUnavailableError,
  isRetryableFreedomStatus,
} from "./errors.js";
import { FREEDOM_REQUEST_TIMEOUT_MS, pathFromUrl, runFreedomRequest } from "./request.js";
import { probeFilterListsHealth, probeFreedomSession } from "./session-probe.js";
import type { FreedomFilterList } from "./types.js";
import type { Logger } from "../utils/logger.js";
import { DEFAULT_BACKOFF_MS, withBackoff } from "../utils/sleep.js";

export interface FreedomSessionOptions {
  headed?: boolean;
  cwd?: string;
  /**
   * When true, open a fresh browser with no saved session (used by login).
   */
  ephemeral?: boolean;
}

const ownedBrowsers = new WeakMap<BrowserContext, Browser>();

/**
 * Open an authenticated Freedom Playwright context.
 *
 * Prefers Playwright `storageState` at the user config path.
 * Falls back to a legacy project-local persistent Chromium profile if present
 * (temporary compatibility; may be removed in a future major version).
 */
export async function openFreedomContext(
  options: FreedomSessionOptions = {},
): Promise<BrowserContext> {
  const headed = options.headed ?? false;
  const cwd = options.cwd;

  if (options.ephemeral) {
    return launchEphemeralContext(headed);
  }

  if (await authStateExists()) {
    const storageState = await loadAuthStorageState();
    return launchStorageStateContext(storageState, headed);
  }

  if (await legacyProfileExists(cwd)) {
    return launchLegacyPersistentContext(getProfileDir(cwd), headed);
  }

  // No session yet — still return an ephemeral context so callers can probe auth.
  return launchEphemeralContext(headed);
}

async function launchStorageStateContext(
  storageState: unknown,
  headed: boolean,
): Promise<BrowserContext> {
  const browser = await chromium.launch({
    headless: !headed,
  });
  const state = storageState as Exclude<BrowserContextOptions["storageState"], undefined>;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  ownedBrowsers.set(context, browser);
  return context;
}

async function launchEphemeralContext(headed: boolean): Promise<BrowserContext> {
  const browser = await chromium.launch({
    headless: !headed,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  ownedBrowsers.set(context, browser);
  return context;
}

async function launchLegacyPersistentContext(
  profileDir: string,
  headed: boolean,
): Promise<BrowserContext> {
  await mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
}

export async function closeFreedomContext(context: BrowserContext): Promise<void> {
  const browser = ownedBrowsers.get(context);
  try {
    await context.close();
  } finally {
    if (browser) {
      ownedBrowsers.delete(context);
      await browser.close().catch(() => undefined);
    }
  }
}

/**
 * Fetch filter lists using the authenticated Playwright request context.
 */
export async function fetchFilterLists(
  context: BrowserContext,
  options: { logger?: Logger; requestTimeoutMs?: number } = {},
): Promise<FreedomFilterList[]> {
  const timeoutMs = options.requestTimeoutMs ?? FREEDOM_REQUEST_TIMEOUT_MS;
  const path = pathFromUrl(FREEDOM_FILTER_LISTS_URL);

  return withBackoff(
    async () => {
      const response = await runFreedomRequest(
        (requestTimeoutMs) =>
          context.request.get(FREEDOM_FILTER_LISTS_URL, {
            failOnStatusCode: false,
            timeout: requestTimeoutMs,
          }),
        {
          method: "GET",
          path,
          timeoutMs,
          ...(options.logger ? { logger: options.logger } : {}),
        },
      );

      const status = response.status();
      if (status === 401 || status === 403) {
        throw new FreedomAuthExpiredError();
      }

      if (status >= 300 && status < 400) {
        throw new FreedomAuthExpiredError();
      }

      if (isRetryableFreedomStatus(status)) {
        const error = new Error(`Freedom filter_lists transient HTTP ${status}`) as Error & {
          status: number;
        };
        error.status = status;
        throw error;
      }

      if (!response.ok()) {
        const bodyPreview = (await response.text()).slice(0, 200);
        throw new Error(
          `Failed to read Freedom filter lists: HTTP ${status}. Body preview: ${bodyPreview}`,
        );
      }

      const contentType = response.headers()["content-type"] ?? "";
      const text = await response.text();

      if (!contentType.includes("application/json") && !text.trimStart().startsWith("{")) {
        if (
          text.toLowerCase().includes("sign in") ||
          text.toLowerCase().includes("log in") ||
          text.toLowerCase().includes("login")
        ) {
          throw new FreedomAuthExpiredError();
        }
        throw new Error(
          `Unexpected Freedom filter_lists response (content-type: ${contentType || "unknown"}).`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new FreedomAuthExpiredError();
      }

      return normalizeFilterListsResponse(parsed);
    },
    {
      delaysMs: DEFAULT_BACKOFF_MS,
      shouldRetry: (error) => {
        if (error instanceof FreedomRequestTimeoutError) {
          return true;
        }
        if (!error || typeof error !== "object") {
          return false;
        }
        const status = (error as { status?: number }).status;
        return typeof status === "number" && isRetryableFreedomStatus(status);
      },
    },
  ).catch((error: unknown) => {
    const status =
      error && typeof error === "object" ? (error as { status?: number }).status : undefined;
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      throw new FreedomFilterListsUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  });
}

export function normalizeFilterListsResponse(payload: unknown): FreedomFilterList[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("Freedom filter_lists response was not an object.");
  }

  const root = payload as Record<string, unknown>;
  const listsValue = root.filter_lists;

  if (!Array.isArray(listsValue)) {
    throw new Error('Freedom filter_lists response missing "filter_lists" array.');
  }

  return listsValue.map((item, index) => normalizeFilterList(item, index));
}

/** Normalize a single filter-list object (GET item or POST create response). */
export function normalizeFilterListPayload(item: unknown, index = 0): FreedomFilterList {
  return normalizeFilterList(item, index);
}

function normalizeFilterList(item: unknown, index: number): FreedomFilterList {
  if (!item || typeof item !== "object") {
    throw new Error(`Freedom filter list at index ${index} was not an object.`);
  }

  const record = item as Record<string, unknown>;
  const id = asNumber(record.id, `filter_lists[${index}].id`);
  const name = asString(record.name, `filter_lists[${index}].name`);
  const count =
    asOptionalNumber(record.count_websites) ?? asOptionalNumber(record.countWebsites) ?? 0;

  const filtersRaw = record.custom_filters ?? record.customFilters ?? [];
  if (!Array.isArray(filtersRaw)) {
    throw new Error(`Freedom filter list ${id} has invalid custom_filters.`);
  }

  const custom_filters = filtersRaw.map((filter, filterIndex) => {
    if (!filter || typeof filter !== "object") {
      throw new Error(`custom_filters[${filterIndex}] on list ${id} was not an object.`);
    }
    const filterRecord = filter as Record<string, unknown>;
    const filterId = asString(
      filterRecord.id ?? filterRecord.name,
      `filter_lists[${index}].custom_filters[${filterIndex}].id`,
    );
    const filterName = asString(
      filterRecord.name ?? filterRecord.id,
      `filter_lists[${index}].custom_filters[${filterIndex}].name`,
    );
    return { id: filterId, name: filterName };
  });

  return {
    id,
    name,
    count_websites: count || custom_filters.length,
    custom_filters,
  };
}

export async function ensureAuthenticated(context: BrowserContext): Promise<void> {
  const session = await probeFreedomSession(context);
  if (session.status === "expired") {
    throw new FreedomAuthExpiredError();
  }
  if (session.status === "unavailable") {
    throw new FreedomAuthUnavailableError();
  }
}

export interface AuthStatusDetails {
  status: FreedomAuthStatus;
  listsHealthy?: boolean;
  accountEmail?: string;
  createdAt?: string;
  lastValidatedAt?: string;
}

/**
 * Lightweight auth probe used by `login`, `auth status`, and command preflights.
 * Session validity is separated from /filter_lists/ health.
 */
export async function probeAuthStatus(
  options: FreedomSessionOptions = {},
): Promise<FreedomAuthStatus> {
  const details = await probeAuthStatusDetails(options);
  return details.status;
}

export async function probeAuthStatusDetails(
  options: FreedomSessionOptions = {},
): Promise<AuthStatusDetails> {
  const hasAuthFile = await authStateExists();
  const hasLegacy = await legacyProfileExists(options.cwd);
  const hasState = hasAuthFile || hasLegacy;
  if (!hasState && !options.ephemeral) {
    return { status: "missing" };
  }

  let context: BrowserContext;
  try {
    context = await openFreedomContext({
      headed: false,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (error) {
    if (error instanceof FreedomAuthFileInvalidError) {
      return { status: "invalid" };
    }
    throw error;
  }

  try {
    const session = await probeFreedomSession(context);
    if (session.status === "expired") {
      return { status: hasState ? "expired" : "missing" };
    }
    if (session.status === "unavailable") {
      return { status: "unavailable" };
    }

    const lists = await probeFilterListsHealth(context);
    if (lists === "unauthorized") {
      return { status: "expired" };
    }

    if (hasAuthFile) {
      await touchAuthValidated(
        session.accountEmail ? { accountEmail: session.accountEmail } : {},
      ).catch(() => undefined);
    }

    return {
      status: "authenticated",
      listsHealthy: lists === "ok",
      ...(session.accountEmail ? { accountEmail: session.accountEmail } : {}),
    };
  } catch (error) {
    if (error instanceof FreedomAuthExpiredError) {
      return { status: hasState ? "expired" : "missing" };
    }
    if (error instanceof FreedomAuthUnavailableError) {
      return { status: "unavailable" };
    }
    // Network / unexpected probe failures → unavailable, not "please login".
    return { status: "unavailable" };
  } finally {
    await closeFreedomContext(context!);
  }
}

/**
 * Fail fast with a clean message when a command needs a valid Freedom session.
 * Does not require /filter_lists/ to be healthy — callers that need lists still
 * hit fetchFilterLists and may receive FreedomFilterListsUnavailableError.
 */
export async function requireAuthenticatedSession(
  options: FreedomSessionOptions = {},
): Promise<BrowserContext> {
  const hasState = (await authStateExists()) || (await legacyProfileExists(options.cwd));
  if (!hasState) {
    throw new FreedomAuthExpiredError();
  }

  const context = await openFreedomContext({
    headed: options.headed ?? false,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });

  try {
    const session = await probeFreedomSession(context);
    if (session.status === "expired") {
      await closeFreedomContext(context);
      throw new FreedomAuthExpiredError();
    }
    if (session.status === "unavailable") {
      await closeFreedomContext(context);
      throw new FreedomAuthUnavailableError();
    }
    if (await authStateExists()) {
      await touchAuthValidated(
        session.accountEmail ? { accountEmail: session.accountEmail } : {},
      ).catch(() => undefined);
    }
    return context;
  } catch (error) {
    if (
      error instanceof FreedomAuthExpiredError ||
      error instanceof FreedomAuthUnavailableError ||
      error instanceof FreedomAuthFileInvalidError
    ) {
      throw error;
    }
    await closeFreedomContext(context);
    throw new FreedomAuthUnavailableError();
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string for ${label}.`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`Expected number for ${label}.`);
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
