import { describe, expect, it } from "vitest";

import type { FreedomFilterList } from "../src/freedom/types.js";
import type { AddDomainsResult, FreedomWriter } from "../src/freedom/writer.js";
import {
  allocateShardWrites,
  buildShardedSyncPlan,
  computeShardCapacity,
  discoverManagedShards,
  formatShardedPlanReport,
  managedShardPattern,
  nextShardNames,
  parseShardIndex,
  parseShardSize,
  shardName,
  theoreticalSourceChunks,
  unionManagedDomains,
} from "../src/sync/shards.js";
import { runShardedAdditiveSync, verifyShardedAdditiveSync } from "../src/sync/sync.js";

function makeList(id: number, name: string, domains: string[]): FreedomFilterList {
  return {
    id,
    name,
    count_websites: domains.length,
    custom_filters: domains.map((domain) => ({ id: domain, name: domain })),
  };
}

describe("shard naming", () => {
  it("recognizes exact base and numbered shards only", () => {
    expect(parseShardIndex("Social Media", "Social Media")).toBe(1);
    expect(parseShardIndex("Social Media", "Social Media 2")).toBe(2);
    expect(parseShardIndex("Social Media", "Social Media 10")).toBe(10);
    expect(parseShardIndex("Social Media", "Social Media Backup")).toBeNull();
    expect(parseShardIndex("Social Media", "Social Media Old")).toBeNull();
    expect(parseShardIndex("Social Media", "Social Media Work")).toBeNull();
    expect(parseShardIndex("Social Media", "Social Media 1")).toBeNull();
    expect(parseShardIndex("Social Media", "Social Medialy")).toBeNull();

    const pattern = managedShardPattern("Social Media");
    expect(pattern.test("Social Media Backup")).toBe(false);
  });

  it("escapes regex metacharacters in the base name", () => {
    const pattern = managedShardPattern("Foo (bar)");
    expect(pattern.test("Foo (bar)")).toBe(true);
    expect(pattern.test("Foo (bar) 2")).toBe(true);
    expect(pattern.test("Foo Xbar)")).toBe(false);
  });

  it("sorts discovered shards numerically (2 before 10)", () => {
    const lists = [
      makeList(3, "Social Media 10", ["z.com"]),
      makeList(1, "Social Media", ["a.com"]),
      makeList(2, "Social Media 2", ["b.com"]),
      makeList(9, "Social Media Backup", ["nope.com"]),
    ];
    const managed = discoverManagedShards(lists, "Social Media");
    expect(managed.map((list) => list.name)).toEqual([
      "Social Media",
      "Social Media 2",
      "Social Media 10",
    ]);
  });

  it("parses shard indexes", () => {
    expect(parseShardIndex("Social Media", "Social Media")).toBe(1);
    expect(parseShardIndex("Social Media", "Social Media 2")).toBe(2);
    expect(parseShardIndex("Social Media", "Social Media 10")).toBe(10);
    expect(parseShardIndex("Social Media", "Social Media Backup")).toBeNull();
  });

  it("builds shard display names", () => {
    expect(shardName("Social Media", 1)).toBe("Social Media");
    expect(shardName("Social Media", 2)).toBe("Social Media 2");
  });
});

describe("shard capacity", () => {
  it("reports remaining capacity under the limit", () => {
    expect(computeShardCapacity(2400, 2500)).toEqual({
      current: 2400,
      maximum: 2500,
      remaining: 100,
      oversized: false,
    });
  });

  it("gives oversized shards zero remaining capacity", () => {
    expect(computeShardCapacity(5693, 2500)).toEqual({
      current: 5693,
      maximum: 2500,
      remaining: 0,
      oversized: true,
    });
  });

  it("treats exact-full shards as having zero remaining", () => {
    expect(computeShardCapacity(2500, 2500).remaining).toBe(0);
    expect(computeShardCapacity(2500, 2500).oversized).toBe(false);
  });
});

describe("global domain union", () => {
  it("unions domains across managed shards", () => {
    const shards = [
      makeList(1, "Social Media", ["a.com", "b.com"]),
      makeList(2, "Social Media 2", ["b.com", "c.com"]),
    ];
    expect([...unionManagedDomains(shards)].sort()).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("does not treat a domain in the wrong shard as missing", () => {
    const plan = buildShardedSyncPlan({
      mode: "additive",
      dryRun: true,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:x",
      sourceDomains: ["example.com", "other.com"],
      baseName: "Social Media",
      shardSize: 3,
      allLists: [makeList(1, "Social Media", []), makeList(2, "Social Media 2", ["example.com"])],
    });

    expect(plan.domainsToAdd).toEqual(["other.com"]);
    expect(plan.diff.unchangedCount).toBe(1);
  });
});

describe("shard allocation", () => {
  it("fills partial shards before planning new ones", () => {
    const existing = [
      makeList(1, "Social Media", ["a.com", "b.com", "c.com"]),
      makeList(2, "Social Media 2", ["d.com"]),
    ];
    const allocations = allocateShardWrites({
      baseName: "Social Media",
      shardSize: 3,
      existingShards: existing,
      allLists: existing,
      domainsToAdd: ["e.com", "f.com", "g.com"],
    });

    expect(allocations).toEqual([
      {
        name: "Social Media 2",
        list: existing[1],
        domains: ["e.com", "f.com"],
        isNew: false,
        currentCount: 1,
        maximum: 3,
      },
      {
        name: "Social Media 3",
        domains: ["g.com"],
        isNew: true,
        currentCount: 0,
        maximum: 3,
      },
    ]);
  });

  it("does not add to an oversized shard", () => {
    const existing = [makeList(1, "Social Media", ["a.com", "b.com", "c.com", "d.com"])];
    const allocations = allocateShardWrites({
      baseName: "Social Media",
      shardSize: 3,
      existingShards: existing,
      allLists: existing,
      domainsToAdd: ["e.com"],
    });

    expect(allocations).toEqual([
      {
        name: "Social Media 2",
        domains: ["e.com"],
        isNew: true,
        currentCount: 0,
        maximum: 3,
      },
    ]);
  });

  it("fills numbering gaps before extending", () => {
    const existing = [
      makeList(1, "Social Media", ["a.com"]),
      makeList(2, "Social Media 2", ["b.com"]),
      makeList(4, "Social Media 4", ["c.com"]),
    ];
    expect(nextShardNames("Social Media", existing, existing, 2)).toEqual([
      "Social Media 3",
      "Social Media 5",
    ]);
  });

  it("plans the documented example allocation", () => {
    const plan = buildShardedSyncPlan({
      mode: "additive",
      dryRun: true,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:x",
      sourceDomains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com"],
      baseName: "Social Media",
      shardSize: 3,
      allLists: [
        makeList(1, "Social Media", ["a.com", "b.com", "c.com"]),
        makeList(2, "Social Media 2", ["d.com"]),
      ],
    });

    expect(
      plan.allocations.map((allocation) => ({
        name: allocation.name,
        domains: allocation.domains,
        isNew: allocation.isNew,
      })),
    ).toEqual([
      { name: "Social Media 2", domains: ["e.com", "f.com"], isNew: false },
      { name: "Social Media 3", domains: ["g.com"], isNew: true },
    ]);
  });
});

describe("theoretical source chunks", () => {
  it("divides sorted domains into fixed-size chunks", () => {
    expect(theoreticalSourceChunks(["e.com", "a.com", "b.com", "c.com", "d.com"], 2)).toEqual([
      ["a.com", "b.com"],
      ["c.com", "d.com"],
      ["e.com"],
    ]);
  });
});

describe("shard size parsing", () => {
  it("defaults to 2500", () => {
    expect(parseShardSize(undefined)).toBe(2500);
  });

  it("rejects unsafe sizes without override", () => {
    expect(() => parseShardSize("50")).toThrow(/safe minimum/);
    expect(() => parseShardSize("6000")).toThrow(/safe maximum/);
  });

  it("allows unsafe sizes with override", () => {
    expect(parseShardSize("50", { allowUnsafe: true })).toBe(50);
    expect(parseShardSize("6000", { allowUnsafe: true })).toBe(6000);
  });
});

describe("sharded dry-run and verification", () => {
  it("dry-run does not create shards or write", async () => {
    class RecordingWriter implements FreedomWriter {
      calls: Array<{ listId: number; domains: string[] }> = [];
      async addDomains(listId: number, domains: string[]): Promise<AddDomainsResult> {
        this.calls.push({ listId, domains });
        return { requested: domains.length };
      }
    }

    const writer = new RecordingWriter();
    const plan = buildShardedSyncPlan({
      mode: "additive",
      dryRun: true,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:x",
      sourceDomains: ["a.com", "b.com", "c.com", "d.com"],
      baseName: "Social Media",
      shardSize: 2,
      allLists: [makeList(1, "Social Media", ["a.com"])],
    });

    const result = await runShardedAdditiveSync({
      plan,
      writer,
      delayBetweenBatches: false,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(result.dryRun).toBe(true);
    expect(writer.calls).toEqual([]);
    expect(plan.newShardNames).toEqual(["Social Media 2"]);
    expect(formatShardedPlanReport(plan)).toContain("Existing shards:     1");
    expect(formatShardedPlanReport(plan)).toContain("New shards required: 1");
    expect(formatShardedPlanReport(plan)).toContain("Will create:");
    expect(formatShardedPlanReport(plan)).toContain("Social Media 2");
  });

  it("verifies global presence across shards", () => {
    const verification = verifyShardedAdditiveSync({
      sourceDomains: ["a.com", "b.com", "c.com"],
      shards: [
        makeList(1, "Social Media", ["a.com", "extra.com"]),
        makeList(2, "Social Media 2", ["c.com"]),
      ],
    });

    expect(verification.stillMissing).toBe(1);
    expect(verification.missingDomains).toEqual(["b.com"]);
    expect(verification.onlyInFreedom).toBe(1);
    expect(verification.presentAcrossShards).toBe(2);
  });

  it("writes only into existing capacity and reports required new shards", async () => {
    class RecordingWriter implements FreedomWriter {
      calls: Array<{ listId: number; domains: string[] }> = [];
      async addDomains(listId: number, domains: string[]): Promise<AddDomainsResult> {
        this.calls.push({ listId, domains: [...domains] });
        return { requested: domains.length };
      }
    }

    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fls-shard-"));
    const previous = process.cwd();
    process.chdir(cwd);

    try {
      const writer = new RecordingWriter();
      const plan = buildShardedSyncPlan({
        mode: "additive",
        dryRun: false,
        sourceUrl: "https://example.com/list.txt",
        sourceHash: "sha256:x",
        sourceDomains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com"],
        baseName: "Social Media",
        shardSize: 3,
        allLists: [
          makeList(1, "Social Media", ["a.com", "b.com", "c.com"]),
          makeList(2, "Social Media 2", ["d.com"]),
        ],
      });

      await expect(
        runShardedAdditiveSync({
          plan,
          writer,
          delayBetweenBatches: false,
          logger: { info() {}, warn() {}, error() {} },
        }),
      ).rejects.toThrow(/Additional shard required/);

      expect(writer.calls).toEqual([{ listId: 2, domains: ["e.com", "f.com"] }]);
    } finally {
      process.chdir(previous);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("auto-creates missing shards when a list creator is provided", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fls-create-"));
    const previous = process.cwd();
    process.chdir(cwd);

    try {
      class RecordingWriter implements FreedomWriter {
        calls: Array<{ listId: number; domains: string[] }> = [];
        async addDomains(listId: number, domains: string[]): Promise<AddDomainsResult> {
          this.calls.push({ listId, domains: [...domains] });
          return { requested: domains.length };
        }
      }

      class FakeCreator {
        created: string[] = [];
        async createFilterList(name: string) {
          this.created.push(name);
          return makeList(100 + this.created.length, name, []);
        }
      }

      const writer = new RecordingWriter();
      const listCreator = new FakeCreator();
      const plan = buildShardedSyncPlan({
        mode: "additive",
        dryRun: false,
        sourceUrl: "https://example.com/list.txt",
        sourceHash: "sha256:x",
        sourceDomains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com"],
        baseName: "Social Media",
        shardSize: 3,
        allLists: [
          makeList(1, "Social Media", ["a.com", "b.com", "c.com"]),
          makeList(2, "Social Media 2", ["d.com"]),
        ],
      });

      const result = await runShardedAdditiveSync({
        plan,
        writer,
        listCreator,
        delayBetweenBatches: false,
        logger: { info() {}, warn() {}, error() {} },
      });

      expect(listCreator.created).toEqual(["Social Media 3"]);
      expect(writer.calls).toEqual([
        { listId: 2, domains: ["e.com", "f.com"] },
        { listId: 101, domains: ["g.com"] },
      ]);
      expect(result.added).toBe(3);
      expect(result.managedShardCount).toBe(3);
    } finally {
      process.chdir(previous);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
