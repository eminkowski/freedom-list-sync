/** Default caps to avoid accidentally ingesting huge unrelated files. */
export const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024; // 32 MiB
export const DEFAULT_MAX_SOURCE_DOMAINS = 250_000;

export class SourceTooLargeError extends Error {
  constructor(kind: "bytes" | "domains", actual: number, limit: number) {
    const formatted =
      kind === "bytes"
        ? `Source is too large (${formatBytes(actual)} > ${formatBytes(limit)}).`
        : `Source produced too many domains (${actual.toLocaleString("en-US")} > ${limit.toLocaleString("en-US")}).`;
    super(`${formatted}\n\nIf this is intentional, raise the limit in code or split the source.`);
    this.name = "SourceTooLargeError";
  }
}

export function assertSourceByteLimit(byteLength: number, limit = DEFAULT_MAX_SOURCE_BYTES): void {
  if (byteLength > limit) {
    throw new SourceTooLargeError("bytes", byteLength, limit);
  }
}

export function assertDomainCountLimit(
  domainCount: number,
  limit = DEFAULT_MAX_SOURCE_DOMAINS,
): void {
  if (domainCount > limit) {
    throw new SourceTooLargeError("domains", domainCount, limit);
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
