import { normalizeDomain } from "../domains/normalize.js";
import { StrictParseError } from "./errors.js";
import type { ParseOptions, ParsedSource, SourceParser } from "./source.js";

const DEFAULT_OBJECT_FIELDS = ["domain", "hostname", "host", "website", "site", "url", "name"];
const DEFAULT_ARRAY_KEYS = ["domains", "hosts", "sites", "websites", "blocklist", "entries"];

/**
 * JSON source parser for intentionally simple shapes:
 *
 * - `["facebook.com", "instagram.com"]`
 * - `{ "domains": ["facebook.com", ...] }`
 * - `[{ "domain": "facebook.com" }, ...]`
 */
export class JsonSourceParser implements SourceParser {
  readonly format = "json" as const;

  canParse(content: string): boolean {
    const parsed = tryParseJson(content);
    if (parsed === undefined) {
      return false;
    }
    return describeJsonShape(parsed, { forAutoDetect: true }) !== null;
  }

  parse(content: string, options: ParseOptions = {}): ParsedSource {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Source is not valid JSON.");
    }

    const shape = describeJsonShape(parsed, { forAutoDetect: false });
    if (!shape) {
      throw new Error(
        "Unsupported JSON shape. Expected a string array, " +
          'an object with a domains/hosts array, or an array of objects with a domain field.',
      );
    }

    const values = extractDomainValues(parsed, shape, options.domainField);
    const unique = new Set<string>();
    let invalidLineCount = 0;
    let duplicateCount = 0;
    let ignoredLineCount = 0;

    for (const value of values) {
      if (value === null) {
        ignoredLineCount += 1;
        continue;
      }
      if (typeof value !== "string") {
        invalidLineCount += 1;
        continue;
      }
      const domain = normalizeDomain(value, { allowUrl: true });
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
      inputLineCount: values.length,
      ignoredLineCount,
      invalidLineCount,
      duplicateCount,
    };
  }
}

type JsonShape =
  | { kind: "string-array" }
  | { kind: "object-array" }
  | { kind: "wrapped-array"; key: string };

export function looksLikeJsonDocument(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function tryParseJson(content: string): unknown | undefined {
  if (!looksLikeJsonDocument(content)) {
    return undefined;
  }
  try {
    return JSON.parse(content.trim());
  } catch {
    return undefined;
  }
}

function describeJsonShape(
  value: unknown,
  options: { forAutoDetect: boolean },
): JsonShape | null {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { kind: "string-array" };
    }
    if (value.every((item) => typeof item === "string" || item === null)) {
      return { kind: "string-array" };
    }
    if (value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      if (options.forAutoDetect) {
        const objects = value as Record<string, unknown>[];
        const hasKnownDomainField = objects.some((item) =>
          DEFAULT_OBJECT_FIELDS.some((key) => typeof item[key] === "string"),
        );
        return hasKnownDomainField ? { kind: "object-array" } : null;
      }
      return { kind: "object-array" };
    }
    return null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of DEFAULT_ARRAY_KEYS) {
      if (Array.isArray(record[key])) {
        return { kind: "wrapped-array", key };
      }
    }
  }

  return null;
}

function extractDomainValues(
  value: unknown,
  shape: JsonShape,
  domainField: string | undefined,
): unknown[] {
  if (shape.kind === "string-array") {
    return value as unknown[];
  }

  if (shape.kind === "wrapped-array") {
    const record = value as Record<string, unknown>;
    const nested = record[shape.key];
    if (!Array.isArray(nested)) {
      return [];
    }
    if (nested.every((item) => typeof item === "string" || item === null)) {
      return nested;
    }
    if (nested.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      assertObjectArrayDomainField(nested as Record<string, unknown>[], domainField);
      return nested.map((item) => readObjectField(item as Record<string, unknown>, domainField));
    }
    return nested;
  }

  // object-array
  assertObjectArrayDomainField(value as Record<string, unknown>[], domainField);
  return (value as unknown[]).map((item) =>
    readObjectField(item as Record<string, unknown>, domainField),
  );
}

function assertObjectArrayDomainField(
  objects: Record<string, unknown>[],
  domainField: string | undefined,
): void {
  if (objects.length === 0) {
    return;
  }
  if (domainField) {
    return;
  }
  const sample = objects[0]!;
  const hasKnown = DEFAULT_OBJECT_FIELDS.some((key) => typeof sample[key] === "string");
  if (!hasKnown) {
    const available = Object.keys(sample)
      .map((key) => JSON.stringify(key))
      .join(", ");
    throw new Error(
      "JSON object array has no recognizable domain field. " +
        "Pass --domain-field <name>.\n\n" +
        `Available fields on the first object: ${available || "(none)"}`,
    );
  }
}

function readObjectField(
  record: Record<string, unknown>,
  domainField: string | undefined,
): unknown {
  if (domainField) {
    if (!(domainField in record)) {
      throw new Error(
        `JSON object is missing field ${JSON.stringify(domainField)}. ` +
          `Available fields: ${Object.keys(record)
            .map((key) => JSON.stringify(key))
            .join(", ") || "(none)"}`,
      );
    }
    const value = record[domainField];
    if (typeof value !== "string") {
      throw new Error(
        `JSON field ${JSON.stringify(domainField)} must be a string, ` +
          `got ${value === null ? "null" : typeof value}.`,
      );
    }
    return value;
  }

  for (const key of DEFAULT_OBJECT_FIELDS) {
    if (key in record && typeof record[key] === "string") {
      return record[key];
    }
  }

  return undefined;
}
