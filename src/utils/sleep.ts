export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function jitteredDelay(minMs: number, maxMs: number): Promise<void> {
  if (maxMs < minMs) {
    throw new Error(`maxMs (${maxMs}) must be >= minMs (${minMs})`);
  }
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

export const DEFAULT_BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000] as const;

export async function withBackoff<T>(
  operation: () => Promise<T>,
  options: {
    delaysMs?: readonly number[];
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_BACKOFF_MS;
  const shouldRetry = options.shouldRetry ?? isTransientError;
  const sleeper = options.sleep ?? sleep;

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delays.length || !shouldRetry(error)) {
        throw error;
      }
      const delayMs = delays[attempt] ?? 10_000;
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleeper(delayMs);
      attempt += 1;
    }
  }
}

export function isTransientError(error: unknown): boolean {
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
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const code = maybe.code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }

  const message = maybe.message?.toLowerCase() ?? "";
  return (
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("rate limit")
  );
}
