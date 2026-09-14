import { describe, expect, it } from "vitest";

import { normalizeFilterListsResponse } from "../src/freedom/client.js";
import { resolveFilterList } from "../src/freedom/reader.js";
import type { FreedomFilterList } from "../src/freedom/types.js";
import { FreedomListAmbiguousError, FreedomListNotFoundError } from "../src/freedom/auth.js";

describe("normalizeFilterListsResponse", () => {
  it("parses the documented Freedom response shape", () => {
    const lists = normalizeFilterListsResponse({
      filter_lists: [
        {
          id: 6618622,
          name: "Example List",
          count_websites: 2,
          custom_filters: [
            { id: "example.com", name: "example.com" },
            { id: "foo.net", name: "foo.net" },
          ],
        },
      ],
    });

    expect(lists).toEqual([
      {
        id: 6618622,
        name: "Example List",
        count_websites: 2,
        custom_filters: [
          { id: "example.com", name: "example.com" },
          { id: "foo.net", name: "foo.net" },
        ],
      },
    ]);
  });

  it("tolerates camelCase field aliases", () => {
    const lists = normalizeFilterListsResponse({
      filter_lists: [
        {
          id: "42",
          name: "Alias List",
          countWebsites: 1,
          customFilters: [{ id: "a.com", name: "a.com" }],
        },
      ],
    });

    expect(lists[0]?.id).toBe(42);
    expect(lists[0]?.count_websites).toBe(1);
    expect(lists[0]?.custom_filters).toHaveLength(1);
  });
});

describe("resolveFilterList", () => {
  const lists: FreedomFilterList[] = [
    {
      id: 1,
      name: "Alpha",
      count_websites: 0,
      custom_filters: [],
    },
    {
      id: 2,
      name: "Beta",
      count_websites: 0,
      custom_filters: [],
    },
    {
      id: 3,
      name: "Beta",
      count_websites: 0,
      custom_filters: [],
    },
  ];

  it("resolves by numeric id", () => {
    expect(resolveFilterList(lists, "1").name).toBe("Alpha");
  });

  it("resolves by exact name", () => {
    expect(resolveFilterList(lists, "Alpha").id).toBe(1);
  });

  it("fails when a name matches more than one list", () => {
    expect(() => resolveFilterList(lists, "Beta")).toThrow(FreedomListAmbiguousError);
  });

  it("fails when nothing matches", () => {
    expect(() => resolveFilterList(lists, "Missing")).toThrow(FreedomListNotFoundError);
  });
});
