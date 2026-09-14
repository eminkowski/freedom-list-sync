import type { BrowserContext } from "playwright";

import {
  FREEDOM_FILTER_LISTS_URL,
  FREEDOM_HOME_URL,
  FREEDOM_ORIGIN,
} from "./auth.js";
import { FREEDOM_REQUEST_TIMEOUT_MS, runFreedomRequest } from "./request.js";

/** Lighter than /filter_lists/ — observed on dashboard loads and less likely to serialize huge custom lists. */
export const FREEDOM_CURATED_FILTERS_URL = `${FREEDOM_ORIGIN}/curated_filters/`;

export type SessionProbeStatus = "authenticated" | "expired" | "unavailable";

export interface SessionProbeOutcome {
  status: SessionProbeStatus;
  /** Only set when Freedom explicitly returns an account email. */
  accountEmail?: string;
}

/**
 * Determine whether the Playwright context has a usable Freedom session.
 *
 * Intentionally does NOT use GET /filter_lists/ as the primary signal: that
 * endpoint can HTTP 500 when an oversized blocklist exists even though the
 * user is still authenticated.
 *
 * When both lightweight signals are unreachable or inconclusive, returns
 * `unavailable` — not `expired` — so callers do not tell users to log in again.
 */
export async function probeFreedomSession(
  context: BrowserContext,
): Promise<SessionProbeOutcome> {
  const curated = await probeCuratedFilters(context);
  if (curated.status !== "inconclusive") {
    return curated.status === "authenticated"
      ? withOptionalEmail({ status: "authenticated" }, curated.accountEmail)
      : { status: curated.status };
  }

  try {
    return await probeHomePageSession(context);
  } catch {
    return { status: "unavailable" };
  }
}

async function probeCuratedFilters(
  context: BrowserContext,
): Promise<
  | { status: SessionProbeStatus; accountEmail?: string }
  | { status: "inconclusive" }
> {
  try {
    const response = await runFreedomRequest(
      (timeoutMs) =>
        context.request.get(FREEDOM_CURATED_FILTERS_URL, {
          failOnStatusCode: false,
          timeout: timeoutMs,
          maxRedirects: 0,
        }),
      {
        method: "GET",
        path: "/curated_filters/",
        timeoutMs: FREEDOM_REQUEST_TIMEOUT_MS,
      },
    );

    const status = response.status();
    if (status === 401 || status === 403) {
      return { status: "expired" };
    }
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"] ?? "";
      if (/sign[_-]?in|login/i.test(location)) {
        return { status: "expired" };
      }
      // Other redirects are inconclusive.
      return { status: "inconclusive" };
    }
    if (status === 200) {
      const contentType = response.headers()["content-type"] ?? "";
      const text = await response.text();
      if (
        contentType.includes("application/json") ||
        text.trimStart().startsWith("[") ||
        text.trimStart().startsWith("{")
      ) {
        let accountEmail: string | undefined;
        try {
          accountEmail = extractAccountEmail(JSON.parse(text));
        } catch {
          // Non-JSON body with JSON-ish start — still treat as authenticated.
        }
        return withOptionalEmail({ status: "authenticated" }, accountEmail);
      }
      if (/sign in|log in|sign_in/i.test(text)) {
        return { status: "expired" };
      }
      return { status: "authenticated" };
    }
    // 5xx / odd statuses: do not treat as logged-out.
    return { status: "inconclusive" };
  } catch {
    return { status: "inconclusive" };
  }
}

async function probeHomePageSession(context: BrowserContext): Promise<SessionProbeOutcome> {
  const response = await runFreedomRequest(
    (timeoutMs) =>
      context.request.get(FREEDOM_HOME_URL, {
        failOnStatusCode: false,
        timeout: timeoutMs,
        maxRedirects: 5,
      }),
    {
      method: "GET",
      path: "/",
      timeoutMs: FREEDOM_REQUEST_TIMEOUT_MS,
    },
  );

  const status = response.status();
  if (status === 401 || status === 403) {
    return { status: "expired" };
  }

  if (status >= 500) {
    return { status: "unavailable" };
  }

  const finalUrl = response.url();
  if (/sign[_-]?in|login/i.test(finalUrl)) {
    return { status: "expired" };
  }

  const text = await response.text();
  const lower = text.toLowerCase();

  // Strong logged-out signals.
  if (
    lower.includes('name="user[email]"') ||
    lower.includes("users/sign_in") ||
    (lower.includes("sign in") && lower.includes("password") && !lower.includes("sign out"))
  ) {
    return { status: "expired" };
  }

  // Strong logged-in signals from the dashboard shell.
  if (
    lower.includes("sign out") ||
    lower.includes("log out") ||
    lower.includes("blocklists") ||
    lower.includes("filter_lists") ||
    lower.includes("my sessions")
  ) {
    return withOptionalEmail({ status: "authenticated" }, extractAccountEmailFromHtml(text));
  }

  // If we got a normal 200 on the app origin without landing on sign-in, treat as authed.
  if (status === 200 && finalUrl.startsWith(FREEDOM_ORIGIN)) {
    return withOptionalEmail({ status: "authenticated" }, extractAccountEmailFromHtml(text));
  }

  // Both lightweight signals failed to confirm either way.
  return { status: "unavailable" };
}

/**
 * Optional secondary check used only after session auth is confirmed, to report
 * whether list APIs are healthy.
 */
export async function probeFilterListsHealth(
  context: BrowserContext,
): Promise<"ok" | "unavailable" | "unauthorized"> {
  try {
    const response = await runFreedomRequest(
      (timeoutMs) =>
        context.request.get(FREEDOM_FILTER_LISTS_URL, {
          failOnStatusCode: false,
          timeout: timeoutMs,
          maxRedirects: 0,
        }),
      {
        method: "GET",
        path: "/filter_lists/",
        timeoutMs: FREEDOM_REQUEST_TIMEOUT_MS,
      },
    );
    const status = response.status();
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
      return "unauthorized";
    }
    if (status === 200) {
      return "ok";
    }
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return "unavailable";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Pull an email only from explicit account-shaped JSON fields. */
export function extractAccountEmail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = asEmail(record.email) ?? asEmail(record.user_email);
  if (direct) {
    return direct;
  }
  if (record.user && typeof record.user === "object") {
    return asEmail((record.user as Record<string, unknown>).email);
  }
  if (record.account && typeof record.account === "object") {
    return asEmail((record.account as Record<string, unknown>).email);
  }
  return undefined;
}

function extractAccountEmailFromHtml(html: string): string | undefined {
  // Only accept an explicitly labeled account email attribute if present.
  const match =
    html.match(/data-user-email=["']([^"']+@[^"']+)["']/i) ??
    html.match(/data-account-email=["']([^"']+@[^"']+)["']/i);
  const candidate = match?.[1]?.trim();
  return candidate && candidate.includes("@") ? candidate : undefined;
}

function asEmail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.includes("@") || trimmed.length > 254) {
    return undefined;
  }
  return trimmed;
}

function withOptionalEmail(
  outcome: { status: "authenticated" },
  accountEmail: string | undefined,
): SessionProbeOutcome {
  return accountEmail ? { status: "authenticated", accountEmail } : { status: "authenticated" };
}
