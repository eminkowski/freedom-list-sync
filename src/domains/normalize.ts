/**
 * Domain normalization and validation helpers.
 *
 * Hosts-format and plain-domain parsers must not treat arbitrary text as URLs.
 * URL-scheme stripping is reserved for a future dedicated URL-list parser.
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const REJECTED_EXACT = new Set([
  "",
  "*",
  "localhost",
  "broadcasthost",
  "local",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "http://",
  "https://",
]);

export interface NormalizeOptions {
  /**
   * When true, strip http(s):// and path/query/hash before validating.
   * Not used by hosts/domains parsers — reserved for a future URL-list format.
   */
  allowUrl?: boolean;
}

/**
 * Normalize a candidate domain string.
 * Returns null when the value is not a usable domain.
 */
export function normalizeDomain(raw: string, options: NormalizeOptions = {}): string | null {
  let value = raw.trim().toLowerCase();

  if (!value || REJECTED_EXACT.has(value)) {
    return null;
  }

  // Wildcards are unsupported in current formats.
  if (value.includes("*")) {
    return null;
  }

  if (options.allowUrl) {
    value = stripUrlDecorations(value);
  }

  value = value.replace(/\.+$/, "");

  if (!value || REJECTED_EXACT.has(value)) {
    return null;
  }

  if (value.includes("/") || value.includes("?") || value.includes("#")) {
    return null;
  }

  if (value.includes("://") || value.startsWith("http:") || value.startsWith("https:")) {
    return null;
  }

  if (value.includes(" ") || value.includes("\t")) {
    return null;
  }

  if (value.startsWith(".") || value.includes("..")) {
    return null;
  }

  if (isIpLiteral(value)) {
    return null;
  }

  if (!isValidDomainName(value)) {
    return null;
  }

  return value;
}

export function normalizeDomains(
  values: Iterable<string>,
  options: NormalizeOptions = {},
): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeDomain(value, options);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique].sort();
}

function stripUrlDecorations(value: string): string {
  let result = value;
  if (result.startsWith("http://") || result.startsWith("https://")) {
    try {
      const url = new URL(result);
      result = url.hostname;
    } catch {
      result = result.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
    }
  } else if (result.includes("/") || result.includes("?") || result.includes("#")) {
    result = result.split(/[/?#]/)[0] ?? "";
  }
  return result.replace(/^\[|\]$/g, "");
}

function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return true;
  }
  if (value.includes(":")) {
    return true;
  }
  return false;
}

function isValidDomainName(value: string): boolean {
  if (value.length > 253) {
    return false;
  }
  if (!value.includes(".")) {
    return false;
  }
  const labels = value.split(".");
  if (labels.some((label) => label.length === 0 || !LABEL_RE.test(label))) {
    return false;
  }
  if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) {
    return false;
  }
  const tld = labels[labels.length - 1];
  // Allow alphabetic TLDs and punycode ASCII TLDs (xn--...).
  if (!tld || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(tld)) {
    return false;
  }
  return true;
}
