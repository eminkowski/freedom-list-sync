import type { Logger } from "../utils/logger.js";
import { FreedomRequestTimeoutError } from "./errors.js";

export const FREEDOM_REQUEST_TIMEOUT_MS = 30_000;
export const FREEDOM_SLOW_WARNING_MS = 10_000;

export interface FreedomRequestOptions {
  method: string;
  path: string;
  timeoutMs?: number;
  warnAfterMs?: number;
  logger?: Logger;
  /** Invoked once when the slow-warning threshold is crossed. */
  onSlow?: (elapsedMs: number) => void;
}

/**
 * Run a Freedom HTTP operation with a hard timeout and optional slow warning.
 *
 * `operation` must honor `timeoutMs` by aborting the underlying request
 * (e.g. Playwright `timeout` option). This helper converts timeout failures
 * into FreedomRequestTimeoutError and never leaves a silent hung request.
 */
export async function runFreedomRequest<T>(
  operation: (timeoutMs: number) => Promise<T>,
  options: FreedomRequestOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FREEDOM_REQUEST_TIMEOUT_MS;
  const warnAfterMs = options.warnAfterMs ?? FREEDOM_SLOW_WARNING_MS;
  const started = Date.now();
  let warned = false;

  const warnTimer = setTimeout(() => {
    warned = true;
    const elapsed = Date.now() - started;
    const message = `Freedom ${options.method} is taking longer than expected (${Math.round(elapsed / 1000)}s)...`;
    options.logger?.warn(message);
    options.onSlow?.(elapsed);
  }, warnAfterMs);

  try {
    return await operation(timeoutMs);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new FreedomRequestTimeoutError(options.method, options.path, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(warnTimer);
    if (options.logger && warned) {
      options.logger.info(
        `Freedom ${options.method} ${options.path} finished after ${Date.now() - started}ms`,
      );
    }
  }
}

export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybe = error as { name?: string; message?: string; code?: string };
  if (maybe.name === "TimeoutError") {
    return true;
  }
  if (maybe.code === "ETIMEDOUT" || maybe.code === "UND_ERR_HEADERS_TIMEOUT") {
    return true;
  }
  const message = maybe.message?.toLowerCase() ?? "";
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("exceeded")
  );
}

export function pathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
