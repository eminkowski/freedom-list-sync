import { normalizeDomain } from "../domains/normalize.js";
import { StrictParseError } from "./errors.js";
import {
  isBlankOrComment,
  looksLikeHostsLine,
  looksLikeIpv4,
  meaningfulLines,
  splitLines,
  stripInlineComment,
} from "./line-utils.js";
import type { ParseOptions, ParsedSource, SourceParser } from "./source.js";

/** IPv4 addresses commonly used as sinkholes in hosts-format blocklists. */
const BLOCK_IPS = new Set(["0.0.0.0", "127.0.0.1"]);

const IGNORED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "broadcasthost",
  "local",
  "ip6-localhost",
  "ip6-loopback",
]);

/**
 * Hosts-format source parser.
 *
 * Extracts hostnames mapped to sinkhole IPs such as 0.0.0.0 / 127.0.0.1.
 * No vendor-specific assumptions.
 */
export class HostsSourceParser implements SourceParser {
  readonly format = "hosts" as const;

  canParse(content: string): boolean {
    const lines = meaningfulLines(content);
    if (lines.length === 0) {
      return false;
    }

    const sample = lines.slice(0, 300);
    let hostsLike = 0;
    for (const line of sample) {
      if (looksLikeHostsLine(line)) {
        hostsLike += 1;
      }
    }

    // Require a clear majority of meaningful lines to look like hosts entries.
    return hostsLike / sample.length >= 0.7;
  }

  parse(content: string, options: ParseOptions = {}): ParsedSource {
    const lines = splitLines(content);
    const unique = new Set<string>();
    let ignoredLineCount = 0;
    let invalidLineCount = 0;
    let duplicateCount = 0;

    for (const rawLine of lines) {
      if (isBlankOrComment(rawLine)) {
        ignoredLineCount += 1;
        continue;
      }

      const line = stripInlineComment(rawLine).trim();
      if (!line) {
        ignoredLineCount += 1;
        continue;
      }

      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        invalidLineCount += 1;
        continue;
      }

      const ip = parts[0] ?? "";
      if (!BLOCK_IPS.has(ip)) {
        // IPv6 localhost / other IPs are ignored as non-block hosts noise,
        // unless they look like a malformed attempt at a block entry with a domain.
        if (ip === "::1" || (looksLikeIpv4(ip) && parts.slice(1).every(isIgnoredHostname))) {
          ignoredLineCount += 1;
          continue;
        }
        if (!looksLikeIpv4(ip) && !ip.includes(":")) {
          invalidLineCount += 1;
          continue;
        }
        // Non-supported sinkhole IP with hostnames: count as ignored hosts noise.
        ignoredLineCount += 1;
        continue;
      }

      const hostnames = parts.slice(1);
      let producedValid = false;
      let sawIgnoredOnly = true;

      for (const candidate of hostnames) {
        if (isIgnoredHostname(candidate)) {
          continue;
        }
        sawIgnoredOnly = false;
        const domain = normalizeDomain(candidate);
        if (!domain) {
          invalidLineCount += 1;
          continue;
        }
        producedValid = true;
        if (unique.has(domain)) {
          duplicateCount += 1;
        } else {
          unique.add(domain);
        }
      }

      if (!producedValid) {
        if (sawIgnoredOnly) {
          ignoredLineCount += 1;
        }
        // else: invalid already counted per bad hostname
      }
    }

    if (options.strict && invalidLineCount > 0) {
      throw new StrictParseError(invalidLineCount, this.format);
    }

    return {
      format: this.format,
      domains: [...unique].sort(),
      inputLineCount: lines.length,
      ignoredLineCount,
      invalidLineCount,
      duplicateCount,
    };
  }
}

function isIgnoredHostname(value: string): boolean {
  return IGNORED_HOSTNAMES.has(value.trim().toLowerCase().replace(/\.+$/, ""));
}

/** @deprecated Use HostsSourceParser */
export class HostsSource extends HostsSourceParser {}
