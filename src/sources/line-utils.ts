/**
 * Shared helpers for source parsers.
 */

export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

export function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * Strip an inline `# comment`, but only when `#` is preceded by whitespace
 * or appears at the start of the (already-trimmed) line.
 */
export function stripInlineComment(line: string): string {
  const hash = line.search(/(^|\s)#/);
  if (hash === -1) {
    return line;
  }
  // If match includes leading whitespace before #, keep content before that whitespace.
  const absolute = line.indexOf("#", hash);
  if (absolute <= 0) {
    return "";
  }
  return line.slice(0, absolute).trimEnd();
}

export function meaningfulLines(content: string): string[] {
  return splitLines(content)
    .map((line) => stripInlineComment(line).trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function looksLikeIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

export function looksLikeHostsLine(line: string): boolean {
  const parts = stripInlineComment(line).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  const ip = parts[0] ?? "";
  return looksLikeIpv4(ip) || ip === "::1" || ip.includes(":");
}

export function looksLikePlainDomainLine(line: string): boolean {
  const value = stripInlineComment(line).trim();
  if (!value || value.includes(" ") || value.includes("\t")) {
    return false;
  }
  if (value.includes("://") || value.startsWith("|") || value.startsWith("*") || value.startsWith("/")) {
    return false;
  }
  // Must look hostname-ish: labels separated by dots, no path.
  return /^[A-Za-z0-9._-]+$/.test(value) && value.includes(".");
}

export function detectUnsupportedSyntax(content: string): string | null {
  const lines = meaningfulLines(content);
  if (lines.length === 0) {
    return null;
  }

  const sample = lines.slice(0, 300);
  let adblock = 0;
  let wildcard = 0;
  let urls = 0;

  for (const line of sample) {
    if (/^\|\|/.test(line) || /\$[a-z0-9,~|-]+$/i.test(line) || line.includes("##") || line.includes("#@#")) {
      adblock += 1;
      continue;
    }
    if (line.startsWith("*.") || line.includes(".*.")) {
      wildcard += 1;
      continue;
    }
    if (/^https?:\/\//i.test(line)) {
      urls += 1;
    }
  }

  const ratio = (count: number) => count / sample.length;

  if (ratio(adblock) >= 0.15) {
    return "This source appears to use Adblock/uBlock filter syntax, which is not supported yet.";
  }
  if (ratio(wildcard) >= 0.15) {
    return "This source appears to use wildcard domain syntax (e.g. *.example.com), which is not supported yet.";
  }
  if (ratio(urls) >= 0.15) {
    return "This source appears to be a URL list, which is not supported yet. Use a domain list, hosts file, CSV, or JSON source.";
  }

  return null;
}
