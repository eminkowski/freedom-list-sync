import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { AmbiguousSourceFormatError, UnsupportedSourceFormatError } from "./errors.js";
import { CsvSourceParser } from "./csv-source.js";
import { HostsSourceParser } from "./hosts-source.js";
import { JsonSourceParser, looksLikeJsonDocument } from "./json-source.js";
import {
  assertDomainCountLimit,
  assertSourceByteLimit,
  DEFAULT_MAX_SOURCE_BYTES,
} from "./limits.js";
import { detectUnsupportedSyntax } from "./line-utils.js";
import { DomainListSourceParser } from "./plain-domain-source.js";
import type {
  ConcreteSourceFormat,
  FetchedSource,
  ParseOptions,
  ParsedSource,
  SourceFormat,
  SourceParser,
} from "./source.js";

const DEFAULT_TIMEOUT_MS = 60_000;

const REJECTED_CONTENT_TYPE_PREFIXES = ["image/", "audio/", "video/", "font/"];
const REJECTED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
]);

const PARSERS: SourceParser[] = [
  new JsonSourceParser(),
  new CsvSourceParser(),
  new HostsSourceParser(),
  new DomainListSourceParser(),
];

export interface LoadSourceOptions extends ParseOptions {
  maxBytes?: number;
  maxDomains?: number;
}

export async function fetchSource(
  url: string,
  format: SourceFormat = "auto",
  options: LoadSourceOptions = {},
): Promise<FetchedSource> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      headers: {
        "user-agent": "freedom-list-sync/0.1 (+https://github.com/eminkowski/freedom-list-sync)",
        accept: "text/plain,application/json,text/csv,*/*",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch source ${url}: ${detail}`);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch source ${url}: HTTP ${response.status} ${response.statusText || ""}`.trim(),
    );
  }

  assertAcceptableContentType(response.headers.get("content-type"));

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared)) {
      assertSourceByteLimit(declared, maxBytes);
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  assertSourceByteLimit(buffer.byteLength, maxBytes);
  const content = buffer.toString("utf8");
  const parsed = parseSourceContent(content, format, options);
  assertDomainCountLimit(parsed.domains.length, options.maxDomains);

  return {
    url,
    contentHash: `sha256:${sha256(content)}`,
    fetchedAt: new Date().toISOString(),
    ...parsed,
  };
}

export async function loadSourceFile(
  filePath: string,
  format: SourceFormat = "auto",
  options: LoadSourceOptions = {},
): Promise<FetchedSource> {
  const resolved = path.resolve(filePath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;

  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read source file ${resolved}: ${detail}`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`Source path is not a file: ${resolved}`);
  }
  assertSourceByteLimit(fileStat.size, maxBytes);

  const content = await readFile(resolved, "utf8");
  assertSourceByteLimit(Buffer.byteLength(content, "utf8"), maxBytes);
  const parsed = parseSourceContent(content, format, options);
  assertDomainCountLimit(parsed.domains.length, options.maxDomains);

  return {
    url: `file://${resolved}`,
    contentHash: `sha256:${sha256(content)}`,
    fetchedAt: new Date().toISOString(),
    ...parsed,
  };
}

/**
 * Load a remote URL or local file into a parsed source.
 * Exactly one of `sourceUrl` / `sourceFile` must be provided by the caller.
 */
export async function loadSource(input: {
  sourceUrl?: string;
  sourceFile?: string;
  format?: SourceFormat;
  options?: LoadSourceOptions;
}): Promise<FetchedSource> {
  const format = input.format ?? "auto";
  const options = input.options ?? {};
  const hasUrl = Boolean(input.sourceUrl?.trim());
  const hasFile = Boolean(input.sourceFile?.trim());

  if (hasUrl === hasFile) {
    throw new Error("Provide exactly one of --source <url> or --source-file <path>.");
  }

  if (hasFile) {
    return loadSourceFile(input.sourceFile!.trim(), format, options);
  }
  return fetchSource(input.sourceUrl!.trim(), format, options);
}

export function parseSourceContent(
  content: string,
  format: SourceFormat = "auto",
  options: ParseOptions = {},
): ParsedSource {
  const unsupported = detectUnsupportedSyntax(content);

  if (format === "auto") {
    if (unsupported) {
      throw new UnsupportedSourceFormatError(unsupported);
    }
    const resolved = detectSourceFormat(content);
    return createSourceParser(resolved).parse(content, options);
  }

  const parser = createSourceParser(format);
  if (unsupported && !parser.canParse(content)) {
    throw new UnsupportedSourceFormatError(unsupported);
  }

  return parser.parse(content, options);
}

export function createSourceParser(format: ConcreteSourceFormat): SourceParser {
  const parser = PARSERS.find((candidate) => candidate.format === format);
  if (!parser) {
    throw new Error(`Unsupported source format: ${format}`);
  }
  return parser;
}

/**
 * Conservative auto-detection.
 * Fails instead of guessing when content is mixed/ambiguous/unsupported.
 */
export function detectSourceFormat(content: string): ConcreteSourceFormat {
  const unsupported = detectUnsupportedSyntax(content);
  if (unsupported) {
    throw new UnsupportedSourceFormatError(unsupported);
  }

  // JSON-looking documents must never fall through to hosts/domains/csv.
  if (looksLikeJsonDocument(content)) {
    if (createSourceParser("json").canParse(content)) {
      return "json";
    }
    throw new UnsupportedSourceFormatError(
      "This source looks like JSON, but it is not valid JSON or does not match a supported JSON shape. " +
        "Use --source-format json with a supported shape, or fix the source.",
    );
  }

  const csvOk = createSourceParser("csv").canParse(content);
  const hostsOk = createSourceParser("hosts").canParse(content);
  const domainsOk = createSourceParser("domains").canParse(content);

  const matches: ConcreteSourceFormat[] = [];
  if (csvOk) {
    matches.push("csv");
  }
  if (hostsOk) {
    matches.push("hosts");
  }
  if (domainsOk) {
    matches.push("domains");
  }

  if (matches.length === 1) {
    return matches[0]!;
  }

  throw new AmbiguousSourceFormatError();
}

function assertAcceptableContentType(contentTypeHeader: string | null): void {
  if (!contentTypeHeader) {
    return;
  }
  const contentType = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType) {
    return;
  }
  if (
    REJECTED_CONTENT_TYPES.has(contentType) ||
    REJECTED_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix))
  ) {
    throw new Error(
      `Refusing source with content-type ${JSON.stringify(contentType)}. ` +
        "Expected a text, CSV, or JSON blocklist body.",
    );
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
