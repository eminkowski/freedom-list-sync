import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FreedomFilterList } from "../src/freedom/types.js";
import type { AddDomainsResult, FreedomWriter } from "../src/freedom/writer.js";
import { createCheckpoint } from "../src/sync/checkpoint.js";
import { buildSyncPlan, runAdditiveSync, SyncInterruptedError } from "../src/sync/sync.js";

class RecordingWriter implements FreedomWriter {
  readonly calls: string[][] = [];
  failOnCall?: number;

  async addDomains(_listId: number, domains: string[]): Promise<AddDomainsResult> {
    this.calls.push([...domains]);
    if (this.failOnCall !== undefined && this.calls.length === this.failOnCall) {
      throw new Error("HTTP 429");
    }
    return { requested: domains.length };
  }
}

function makeList(domains: string[]): FreedomFilterList {
  return {
    id: 99,
    name: "Test List",
    count_websites: domains.length,
    custom_filters: domains.map((domain) => ({ id: domain, name: domain })),
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("additive sync writer targeting", () => {
  it("sends only missing domains", async () => {
    const writer = new RecordingWriter();
    const plan = buildSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: ["a.com", "b.com", "c.com", "d.com"],
      list: makeList(["a.com", "b.com"]),
    });

    const cwd = await mkdtemp(path.join(os.tmpdir(), "fls-"));
    tempDirs.push(cwd);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      await runAdditiveSync({
        plan,
        writer,
        delayBetweenBatches: false,
        logger: { info() {}, warn() {}, error() {} },
      });
    } finally {
      process.chdir(previous);
    }

    expect(writer.calls).toEqual([["c.com", "d.com"]]);
  });

  it("invokes zero writes on dry-run", async () => {
    const writer = new RecordingWriter();
    const plan = buildSyncPlan({
      mode: "additive",
      dryRun: true,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: ["a.com", "b.com", "c.com"],
      list: makeList(["a.com"]),
    });

    const result = await runAdditiveSync({
      plan,
      writer,
      delayBetweenBatches: false,
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(result.dryRun).toBe(true);
    expect(writer.calls).toEqual([]);
  });

  it("is idempotent after a successful simulated sync", async () => {
    const writer = new RecordingWriter();
    const firstPlan = buildSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: ["a.com", "b.com", "c.com"],
      list: makeList(["a.com"]),
    });

    const cwd = await mkdtemp(path.join(os.tmpdir(), "fls-"));
    tempDirs.push(cwd);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      await runAdditiveSync({
        plan: firstPlan,
        writer,
        delayBetweenBatches: false,
        logger: { info() {}, warn() {}, error() {} },
      });

      const secondPlan = buildSyncPlan({
        mode: "additive",
        dryRun: false,
        sourceUrl: "https://example.com/list.txt",
        sourceHash: "sha256:abc",
        sourceDomains: ["a.com", "b.com", "c.com"],
        list: makeList(["a.com", "b.com", "c.com"]),
      });

      await runAdditiveSync({
        plan: secondPlan,
        writer,
        delayBetweenBatches: false,
        logger: { info() {}, warn() {}, error() {} },
      });
    } finally {
      process.chdir(previous);
    }

    expect(writer.calls).toEqual([["b.com", "c.com"]]);
  });

  it("stops after a failed middle batch", async () => {
    const writer = new RecordingWriter();
    writer.failOnCall = 2;

    const domains = Array.from({ length: 120 }, (_, index) => `d${index}.com`);
    const plan = buildSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: domains,
      list: makeList([]),
    });

    const cwd = await mkdtemp(path.join(os.tmpdir(), "fls-"));
    tempDirs.push(cwd);
    const previous = process.cwd();
    process.chdir(cwd);

    let interrupted: SyncInterruptedError | undefined;
    try {
      await runAdditiveSync({
        plan,
        writer,
        batchSize: 50,
        delayBetweenBatches: false,
        checkpoint: createCheckpoint({
          source: plan.sourceUrl,
          targetListId: plan.list.id,
          mode: plan.mode,
          sourceHash: plan.sourceHash,
        }),
        logger: { info() {}, warn() {}, error() {} },
      });
    } catch (error) {
      if (error instanceof SyncInterruptedError) {
        interrupted = error;
      } else {
        throw error;
      }
    } finally {
      process.chdir(previous);
    }

    expect(interrupted).toBeInstanceOf(SyncInterruptedError);
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[0]).toHaveLength(50);
    expect(writer.calls[1]).toHaveLength(50);
    expect(interrupted?.details.failedBatch).toBe(2);
    expect(interrupted?.details.completed).toBe(50);
  });
});
