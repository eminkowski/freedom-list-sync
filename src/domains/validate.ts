import { normalizeDomain } from "./normalize.js";

/**
 * Lightweight validation helpers used by parsers and CLI input checks.
 */
export function isValidDomain(value: string): boolean {
  return normalizeDomain(value) !== null;
}

export function assertValidDomain(value: string): string {
  const normalized = normalizeDomain(value);
  if (!normalized) {
    throw new Error(`Invalid domain: ${JSON.stringify(value)}`);
  }
  return normalized;
}
