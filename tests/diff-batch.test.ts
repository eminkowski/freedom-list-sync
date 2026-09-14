import { describe, expect, it } from "vitest";

import { diffDomains } from "../src/sync/diff.js";
import {
  buildSyncPlan,
  EmptySourceError,
  FREEDOM_BATCH_SIZE,
} from "../src/sync/sync.js";
import { chunk } from "../src/utils/batch.js";
import type { FreedomFilterList } from "../src/freedom/types.js";

describe("diffDomains", () => {
  it("computes additions, removals, and unchanged count", () => {
    const diff = diffDomains(["a.com", "b.com", "c.com", "d.com"], ["a.com", "b.com", "manual.com"]);

    expect(diff.additions).toEqual(["c.com", "d.com"]);
    expect(diff.removals).toEqual(["manual.com"]);
    expect(diff.unchangedCount).toBe(2);
  });

  it("sorts output deterministically", () => {
    const diff = diffDomains(["z.com", "a.com"], ["m.com", "b.com"]);
    expect(diff.additions).toEqual(["a.com", "z.com"]);
    expect(diff.removals).toEqual(["b.com", "m.com"]);
  });
});

describe("chunk", () => {
  it("batches 51 domains into 50 + 1", () => {
    const domains = Array.from({ length: 51 }, (_, index) => `d${index}.com`);
    const batches = chunk(domains, FREEDOM_BATCH_SIZE);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(1);
  });
});

describe("empty source protection", () => {
  const list: FreedomFilterList = {
    id: 1,
    name: "Test",
    count_websites: 2,
    custom_filters: [
      { id: "a.com", name: "a.com" },
      { id: "b.com", name: "b.com" },
    ],
  };

  it("aborts when the remote source is empty", () => {
    expect(() =>
      buildSyncPlan({
        mode: "mirror",
        dryRun: false,
        sourceUrl: "https://example.com/list.txt",
        sourceHash: "sha256:abc",
        sourceDomains: [],
        list,
        previousSourceDomainCount: 5000,
      }),
    ).toThrow(EmptySourceError);
  });

  it("does not allow empty sources even in additive mode", () => {
    expect(() =>
      buildSyncPlan({
        mode: "additive",
        dryRun: true,
        sourceUrl: "https://example.com/list.txt",
        sourceHash: "sha256:abc",
        sourceDomains: [],
        list,
      }),
    ).toThrow(/empty/i);
  });
});
