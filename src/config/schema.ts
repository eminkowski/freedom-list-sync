export type ConfigSyncMode = "additive" | "mirror";
export type ConfigSourceFormat = "hosts" | "domains" | "csv" | "json" | "auto";

export interface ConfigListEntry {
  name: string;
  source: string;
  format?: ConfigSourceFormat;
  freedomList: string;
  mode?: ConfigSyncMode;
  domainColumn?: string;
  domainField?: string;
}

export interface AppConfig {
  lists: ConfigListEntry[];
}

export function parseConfigObject(value: unknown): AppConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Config root must be an object.");
  }

  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.lists)) {
    throw new Error('Config must include a "lists" array.');
  }

  const lists = root.lists.map((entry, index) => parseListEntry(entry, index));
  return { lists };
}

function parseListEntry(entry: unknown, index: number): ConfigListEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`lists[${index}] must be an object.`);
  }

  const record = entry as Record<string, unknown>;
  const name = requireString(record.name, `lists[${index}].name`);
  const source = requireString(record.source, `lists[${index}].source`);
  const freedomList = requireString(record.freedomList, `lists[${index}].freedomList`);

  const format = optionalEnum(
    record.format,
    ["hosts", "domains", "csv", "json", "auto"] as const,
    `lists[${index}].format`,
  );
  const mode = optionalEnum(record.mode, ["additive", "mirror"] as const, `lists[${index}].mode`);
  const domainColumn = optionalString(record.domainColumn, `lists[${index}].domainColumn`);
  const domainField = optionalString(record.domainField, `lists[${index}].domainField`);

  const result: ConfigListEntry = {
    name,
    source,
    freedomList,
  };

  if (format !== undefined) {
    result.format = format;
  }
  if (mode !== undefined) {
    result.mode = mode;
  }
  if (domainColumn !== undefined) {
    result.domainColumn = domainColumn;
  }
  if (domainField !== undefined) {
    result.domainField = domainField;
  }

  return result;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
