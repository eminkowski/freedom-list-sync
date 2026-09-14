import type { ParseOptions, SourceFormat } from "../sources/source.js";

export function parseSourceFormat(value: string): SourceFormat {
  if (
    value === "hosts" ||
    value === "domains" ||
    value === "csv" ||
    value === "json" ||
    value === "auto"
  ) {
    return value;
  }
  throw new Error(`Invalid --source-format: ${value}`);
}

export function buildParseOptions(input: {
  strict?: boolean;
  domainColumn?: string;
  domainField?: string;
}): ParseOptions {
  const options: ParseOptions = {};
  if (input.strict === true) {
    options.strict = true;
  }
  if (input.domainColumn !== undefined && input.domainColumn.trim() !== "") {
    options.domainColumn = input.domainColumn;
  }
  if (input.domainField !== undefined && input.domainField.trim() !== "") {
    options.domainField = input.domainField;
  }
  return options;
}

export function resolveSourceInput(options: { source?: string; sourceFile?: string }): {
  sourceUrl?: string;
  sourceFile?: string;
} {
  const sourceUrl = options.source?.trim() || undefined;
  const sourceFile = options.sourceFile?.trim() || undefined;
  if (Boolean(sourceUrl) === Boolean(sourceFile)) {
    throw new Error("Provide exactly one of --source <url> or --source-file <path>.");
  }
  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceFile ? { sourceFile } : {}),
  };
}
