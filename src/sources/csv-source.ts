import { parse as parseCsv } from "csv-parse/sync";

import { normalizeDomain } from "../domains/normalize.js";
import { StrictParseError } from "./errors.js";
import { isBlankOrComment, meaningfulLines, splitLines } from "./line-utils.js";
import type { ParseOptions, ParsedSource, SourceParser } from "./source.js";

const DEFAULT_HEADER_NAMES = ["domain", "domains", "hostname", "host", "website", "site", "url"];

/**
 * CSV source parser backed by `csv-parse` (quoted fields, embedded commas, etc.).
 *
 * Auto-detection only accepts CSVs with a recognizable domain header.
 * Headerless CSVs require an explicit `--domain-column`.
 */
export class CsvSourceParser implements SourceParser {
  readonly format = "csv" as const;

  canParse(content: string): boolean {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return false;
    }

    const lines = meaningfulLines(content);
    if (lines.length < 2) {
      return false;
    }

    const sample = lines.slice(0, 300);
    let csvLike = 0;
    const widths = new Set<number>();
    for (const line of sample) {
      if (!line.includes(",")) {
        continue;
      }
      csvLike += 1;
      widths.add(parseCsvLine(line).length);
    }

    if (csvLike / sample.length < 0.8) {
      return false;
    }

    const headerFields = parseCsvLine(sample[0] ?? "");
    if (findHeaderIndex(headerFields, DEFAULT_HEADER_NAMES) === -1) {
      return false;
    }

    return widths.size <= 2;
  }

  parse(content: string, options: ParseOptions = {}): ParsedSource {
    const rawLines = splitLines(content);
    const keptLines: string[] = [];
    let ignoredLineCount = 0;

    for (const rawLine of rawLines) {
      if (isBlankOrComment(rawLine)) {
        ignoredLineCount += 1;
        continue;
      }
      keptLines.push(rawLine);
    }

    if (keptLines.length === 0) {
      return emptyResult(this.format, rawLines.length, ignoredLineCount);
    }

    let records: string[][];
    try {
      records = parseCsv(keptLines.join("\n"), {
        relax_column_count: true,
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
      }) as string[][];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse CSV source: ${detail}`);
    }

    const dataRows = records
      .map((fields) => fields.map((field) => String(field ?? "").trim()))
      .filter((fields) => fields.some((field) => field.length > 0));

    if (dataRows.length === 0) {
      return emptyResult(this.format, rawLines.length, ignoredLineCount);
    }

    const { columnIndex, startRow, headerIgnored } = resolveCsvColumn(dataRows, options.domainColumn);
    if (headerIgnored) {
      ignoredLineCount += 1;
    }

    const unique = new Set<string>();
    let invalidLineCount = 0;
    let duplicateCount = 0;

    for (let i = startRow; i < dataRows.length; i += 1) {
      const row = dataRows[i]!;
      const cell = row[columnIndex];
      if (cell === undefined || cell.trim() === "") {
        invalidLineCount += 1;
        continue;
      }

      const domain = normalizeDomain(cell, { allowUrl: true });
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
      inputLineCount: rawLines.length,
      ignoredLineCount,
      invalidLineCount,
      duplicateCount,
    };
  }
}

function emptyResult(
  format: "csv",
  inputLineCount: number,
  ignoredLineCount: number,
): ParsedSource {
  return {
    format,
    domains: [],
    inputLineCount,
    ignoredLineCount,
    invalidLineCount: 0,
    duplicateCount: 0,
  };
}

function resolveCsvColumn(
  rows: string[][],
  domainColumn: string | number | undefined,
): { columnIndex: number; startRow: number; headerIgnored: boolean } {
  const first = rows[0]!;
  const explicit = normalizeColumnOption(domainColumn);

  if (explicit !== null) {
    if (typeof explicit === "number") {
      return { columnIndex: explicit, startRow: 0, headerIgnored: false };
    }
    const headerIndex = findHeaderIndex(first, [explicit]);
    if (headerIndex === -1) {
      throw new Error(
        `CSV header column ${JSON.stringify(explicit)} was not found. ` +
          `Available headers: ${first.map((field) => JSON.stringify(field)).join(", ") || "(none)"}`,
      );
    }
    return { columnIndex: headerIndex, startRow: 1, headerIgnored: true };
  }

  const defaultHeader = findHeaderIndex(first, DEFAULT_HEADER_NAMES);
  if (defaultHeader !== -1) {
    return { columnIndex: defaultHeader, startRow: 1, headerIgnored: true };
  }

  throw new Error(
    "CSV domain column is ambiguous. Pass --domain-column with a header name or 0-based index.\n\n" +
      "Examples:\n\n" +
      "  --domain-column domain\n" +
      "  --domain-column 0",
  );
}

function normalizeColumnOption(
  value: string | number | undefined,
): number | string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid --domain-column index: ${value}`);
    }
    return value;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (!trimmed) {
    throw new Error("Invalid --domain-column: empty value");
  }
  return trimmed;
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const lowered = headers.map((header) => header.trim().toLowerCase());
  for (const candidate of candidates) {
    const index = lowered.indexOf(candidate.toLowerCase());
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

/** Parse one CSV record via csv-parse (quoted commas, escaped quotes, etc.). */
export function parseCsvLine(line: string): string[] {
  const rows = parseCsv(line, {
    relax_column_count: true,
    skip_empty_lines: false,
    trim: true,
    relax_quotes: true,
  }) as string[][];
  return (rows[0] ?? []).map((field) => String(field ?? "").trim());
}
