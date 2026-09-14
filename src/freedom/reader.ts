import type { BrowserContext } from "playwright";

import { FreedomListAmbiguousError, FreedomListNotFoundError } from "./auth.js";
import { ensureAuthenticated, fetchFilterLists } from "./client.js";
import type { FreedomFilterList } from "./types.js";

export async function getFilterLists(context: BrowserContext): Promise<FreedomFilterList[]> {
  await ensureAuthenticated(context);
  return fetchFilterLists(context);
}

export async function findFilterList(
  context: BrowserContext,
  selector: string,
): Promise<FreedomFilterList> {
  const lists = await getFilterLists(context);
  return resolveFilterList(lists, selector);
}

export function resolveFilterList(lists: FreedomFilterList[], selector: string): FreedomFilterList {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new FreedomListNotFoundError(selector);
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    const match = lists.find((list) => list.id === id);
    if (!match) {
      throw new FreedomListNotFoundError(selector);
    }
    return match;
  }

  const matches = lists.filter((list) => list.name === trimmed);
  if (matches.length === 0) {
    throw new FreedomListNotFoundError(selector);
  }
  if (matches.length > 1) {
    throw new FreedomListAmbiguousError(
      selector,
      matches.map((list) => `${list.name} (${list.id})`),
    );
  }

  return matches[0]!;
}

export function listDomains(list: FreedomFilterList): string[] {
  const domains = new Set(list.custom_filters.map((filter) => filter.id.toLowerCase()));
  return [...domains].sort();
}
