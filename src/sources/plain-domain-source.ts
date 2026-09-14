import { normalizeDomain } from "../domains/normalize.js";
import { StrictParseError } from "./errors.js";
import {
  isBlankOrComment,
  looksLikePlainDomainLine,
  meaningfulLines,
  splitLines,
  stripInlineComment,
} from "./line-utils.js";
import type { ParseOptions, ParsedSource, SourceParser } from "./source.js";

/**
 * Plain one-domain-per-line source parser.
 *
 * Explicitly does NOT interpret URLs, Adblock rules, or wildcards.
 * Inline comments after a domain are supported:
 *
 *   example.com # comment
 */
export class DomainListSourceParser implements SourceParser {
  readonly format = "domains" as const;

  canParse(content: string): boolean {
    const lines = meaningfulLines(content);
    if (lines.length === 0) {
      return false;
    }

    const sample = lines.slice(0, 300);
    let domainLike = 0;
    for (const line of sample) {
      if (looksLikePlainDomainLine(line)) {
        domainLike += 1;
      }
    }

    // Require nearly all meaningful lines to look like plain domains.
    return domainLike / sample.length >= 0.9;
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

      // Plain-domain parser rejects URL/Adblock/wildcard syntax outright.
      if (
        line.includes("://") ||
        line.startsWith("|") ||
        line.startsWith("*") ||
        line.startsWith("/") ||
        line.includes(",") ||
        line.includes(" ")
      ) {
        invalidLineCount += 1;
        continue;
      }

      const domain = normalizeDomain(line);
      if (!domain) {
        invalidLineCount += 1;
        continue;
      }

      if (unique.has(domain)) {
        duplicateCount += 1;
      } else {
        unique.add(domain);
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

/** @deprecated Use DomainListSourceParser */
export class PlainDomainSource extends DomainListSourceParser {}
