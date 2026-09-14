import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { parseConfigObject, type AppConfig, type ConfigListEntry } from "./schema.js";

export async function loadConfigFile(filePath: string): Promise<AppConfig> {
  const absolute = path.resolve(filePath);
  const raw = await readFile(absolute, "utf8");
  const parsed = parseYaml(raw);
  return parseConfigObject(parsed);
}

export function findConfigList(config: AppConfig, name: string): ConfigListEntry {
  const matches = config.lists.filter((entry) => entry.name === name);
  if (matches.length === 0) {
    throw new Error(`No config list named ${JSON.stringify(name)}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple config lists named ${JSON.stringify(name)}.`);
  }
  return matches[0]!;
}
