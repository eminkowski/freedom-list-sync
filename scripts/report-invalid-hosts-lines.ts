import { normalizeDomain } from "../src/domains/normalize.js";
import {
  isBlankOrComment,
  looksLikeIpv4,
  splitLines,
  stripInlineComment,
} from "../src/sources/line-utils.js";

const BLOCK_IPS = new Set(["0.0.0.0", "127.0.0.1"]);
const IGNORED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "broadcasthost",
  "local",
  "ip6-localhost",
  "ip6-loopback",
]);

interface InvalidHit {
  lineNumber: number;
  original: string;
  reason: string;
}

/**
 * Dev helper: report hosts-format lines that fail normalization.
 *
 * Usage:
 *   npx tsx scripts/report-invalid-hosts-lines.ts <hosts-url>
 */
async function main(): Promise<void> {
  const sourceUrl = process.argv[2];
  if (!sourceUrl) {
    console.error("Usage: npx tsx scripts/report-invalid-hosts-lines.ts <hosts-url>");
    process.exitCode = 1;
    return;
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source: HTTP ${response.status}`);
  }
  const content = await response.text();
  const lines = splitLines(content);
  const invalid: InvalidHit[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const lineNumber = index + 1;
    const withoutComment = stripInlineComment(rawLine);
    if (isBlankOrComment(withoutComment)) {
      continue;
    }

    const parts = withoutComment.trim().split(/\s+/);
    if (parts.length < 2) {
      invalid.push({
        lineNumber,
        original: rawLine,
        reason: "expected '<ip> <hostname>' hosts mapping",
      });
      continue;
    }

    const [ip, hostname] = parts;
    if (!ip || !hostname) {
      invalid.push({
        lineNumber,
        original: rawLine,
        reason: "missing ip or hostname",
      });
      continue;
    }

    if (!BLOCK_IPS.has(ip) && !looksLikeIpv4(ip)) {
      // Keep scanning; non-block rows may still be informative.
    }

    if (isIgnoredHostname(hostname)) {
      continue;
    }

    const normalized = normalizeDomain(hostname);
    if (!normalized) {
      invalid.push({
        lineNumber,
        original: rawLine,
        reason: `hostname did not normalize: ${JSON.stringify(hostname)}`,
      });
    }
  }

  console.log(`Source: ${sourceUrl}`);
  console.log(`Lines: ${lines.length}`);
  console.log(`Invalid hits: ${invalid.length}`);
  console.log("");
  for (const hit of invalid) {
    console.log(`Line ${hit.lineNumber}`);
    console.log(`  text:   ${hit.original}`);
    console.log(`  reason: ${hit.reason}`);
    console.log("");
  }
}

function isIgnoredHostname(value: string): boolean {
  return IGNORED_HOSTNAMES.has(value.trim().toLowerCase().replace(/\.+$/, ""));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
