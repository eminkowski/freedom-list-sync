export type SourceFormat = "hosts" | "domains" | "csv" | "json" | "auto";
export type ConcreteSourceFormat = Exclude<SourceFormat, "auto">;

/**
 * Metadata-rich result of parsing a remote/local source document.
 */
export interface ParsedSource {
  format: ConcreteSourceFormat;
  domains: string[];
  inputLineCount: number;
  ignoredLineCount: number;
  invalidLineCount: number;
  duplicateCount: number;
}

/**
 * Pluggable source parser contract.
 *
 * Sync/diff know nothing about hosts vs domains vs csv/json internals.
 */
export interface SourceParser {
  readonly format: ConcreteSourceFormat;

  /**
   * Whether this parser can confidently handle the content.
   * Detection should be conservative — prefer false over a wrong true.
   */
  canParse(content: string): boolean;

  parse(content: string, options?: ParseOptions): ParsedSource;
}

export interface ParseOptions {
  /** When true, fail if any meaningful line/entry cannot be parsed. */
  strict?: boolean;
  /**
   * CSV domain column: header name (e.g. `domain`) or 0-based numeric index.
   * When omitted, requires a known header name — never silently guesses column 0.
   */
  domainColumn?: string | number;
  /**
   * JSON object-array field name containing the domain.
   * When omitted, prefers a known field such as `domain` / `hostname`.
   */
  domainField?: string;
}

export interface FetchedSource extends ParsedSource {
  url: string;
  contentHash: string;
  fetchedAt: string;
}

/** @deprecated Prefer SourceParser. Kept briefly for migration clarity. */
export type DomainSource = SourceParser;
