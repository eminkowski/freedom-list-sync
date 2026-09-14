import { FreedomAuthExpiredError } from "./auth.js";

/** Alias matching Phase 6 naming; same behavior as FreedomAuthExpiredError. */
export class FreedomAuthenticationError extends FreedomAuthExpiredError {
  constructor() {
    super();
    this.name = "FreedomAuthenticationError";
  }
}

export class FreedomHttpError extends Error {
  readonly status: number;
  readonly bodyPreview: string;

  constructor(status: number, bodyPreview = "") {
    super(`Freedom HTTP ${status}${bodyPreview ? `: ${bodyPreview}` : ""}`);
    this.name = "FreedomHttpError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

export class FreedomValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreedomValidationError";
  }
}

/**
 * Authenticated GET /filter_lists/ failed in a way that usually indicates
 * server-side failure loading oversized lists.
 */
export class FreedomFilterListsUnavailableError extends Error {
  constructor(detail?: string) {
    const lines = [
      "Freedom could not load the current filter lists.",
      "",
      "The account may contain an oversized blocklist.",
      "",
      "No writes were attempted.",
    ];
    if (detail) {
      lines.push("", `Detail: ${detail}`);
    }
    super(lines.join("\n"));
    this.name = "FreedomFilterListsUnavailableError";
  }
}

/**
 * A Freedom HTTP request exceeded its hard timeout.
 * For PATCH, the server-side outcome is unknown — do not blindly retry the same payload.
 */
export class FreedomRequestTimeoutError extends Error {
  readonly method: string;
  readonly path: string;
  readonly timeoutMs: number;

  constructor(method: string, path: string, timeoutMs: number) {
    super(`Freedom ${method} ${path} timed out after ${timeoutMs}ms`);
    this.name = "FreedomRequestTimeoutError";
    this.method = method;
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

export function isRetryableFreedomStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function isAuthenticationStatus(status: number): boolean {
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}
