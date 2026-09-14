import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FreedomHttpError,
  FreedomRequestTimeoutError,
} from "../src/freedom/errors.js";
import { isRetryableWriterError } from "../src/freedom/http-writer.js";
import type { FreedomFilterList } from "../src/freedom/types.js";
import type { AddDomainsResult, FreedomWriter } from "../src/freedom/writer.js";
import { createCheckpoint } from "../src/sync/checkpoint.js";
import { AdaptiveBatchPacer } from "../src/sync/pacer.js";
import {
  buildSyncPlan,
  resolveTimedOutBatch,
  runAdditiveSync,
  SyncInterruptedError,
} from "../src/sync/sync.js";
import { FREEDOM_REQUEST_TIMEOUT_MS, runFreedomRequest } from "../src/freedom/request.js";

function makeList(id: number, domains: string[]): FreedomFilterList {
  return {
    id,
    name: "Test",
    count_websites: domains.length,
    custom_filters: domains.map((domain) => ({ id: domain, name: domain })),
  };
}

class ScriptedWriter implements FreedomWriter {
  readonly calls: string[][] = [];
  private readonly script: Array<"ok" | "timeout" | "http500">;

  constructor(script: Array<"ok" | "timeout" | "http500">) {
    this.script = [...script];
  }

  async addDomains(_listId: number, domains: string[]): Promise<AddDomainsResult> {
    this.calls.push([...domains]);
    const next = this.script.shift() ?? "ok";
    if (next === "timeout") {
      throw new FreedomRequestTimeoutError("PATCH", "/filter_lists/99", FREEDOM_REQUEST_TIMEOUT_MS);
    }
    if (next === "http500") {
      throw new FreedomHttpError(500, "boom");
    }
    return { requested: domains.length, addedCount: domains.length };
  }
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

describe("resolveTimedOutBatch", () => {
  it("splits committed vs still-missing domains", () => {
    const resolution = resolveTimedOutBatch(
      ["a.com", "b.com", "c.com"],
      makeList(1, ["a.com", "c.com"]),
    );
    expect(resolution.committed).toEqual(["a.com", "c.com"]);
    expect(resolution.stillMissing).toEqual(["b.com"]);
  });
});

describe("PATCH timeout recovery", () => {
  it("treats a timed-out batch as success when Freedom already committed all domains", async () => {
    const writer = new ScriptedWriter(["timeout"]);
    const plan = buildSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: ["a.com", "b.com"],
      list: makeList(99, []),
    });

    const cwd = await mkdtemp(path.join(os.tmpdir(), "fls-"));
    tempDirs.push(cwd);
    const previous = process.cwd();
    process.chdir(cwd);

    try {
      const result = await runAdditiveSync({
        plan,
        writer,
        delayBetweenBatches: false,
        sleep: async () => undefined,
        loadList: async () => makeList(99, ["a.com", "b.com"]),
        logger: { info() {}, warn() {}, error() {} },
        checkpoint: createCheckpoint({
          source: plan.sourceUrl,
          targetListId: 99,
          mode: "additive",
          sourceHash: plan.sourceHash,
        }),
      });
      expect(result.added).toBe(2);
      expect(writer.calls).toEqual([["a.com", "b.com"]]);
    } finally {
      process.chdir(previous);
    }
  });

  it("resends only still-missing domains when the commit was partial/unknown", async () => {
    const writer = new ScriptedWriter(["timeout", "ok"]);
    const plan = buildSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: ["a.com", "b.com", "c.com"],
      list: makeList(99, []),
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
        sleep: async () => undefined,
        loadList: async () => makeList(99, ["a.com"]),
        logger: { info() {}, warn() {}, error() {} },
        checkpoint: createCheckpoint({
          source: plan.sourceUrl,
          targetListId: 99,
          mode: "additive",
          sourceHash: plan.sourceHash,
        }),
      });
      expect(writer.calls).toEqual([
        ["a.com", "b.com", "c.com"],
        ["b.com", "c.com"],
      ]);
    } finally {
      process.chdir(previous);
    }
  });

  it("stops when GET is unavailable after a PATCH timeout", async () => {
    const writer = new ScriptedWriter(["timeout"]);
    const plan = buildSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: "https://example.com/list.txt",
      sourceHash: "sha256:abc",
      sourceDomains: ["a.com", "b.com"],
      list: makeList(99, []),
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
        delayBetweenBatches: false,
        sleep: async () => undefined,
        loadList: async () => {
          throw new FreedomRequestTimeoutError("GET", "/filter_lists/", 30_000);
        },
        logger: { info() {}, warn() {}, error() {} },
        checkpoint: createCheckpoint({
          source: plan.sourceUrl,
          targetListId: 99,
          mode: "additive",
          sourceHash: plan.sourceHash,
        }),
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
    expect(interrupted?.details.reason).toMatch(/GET is unavailable/i);
    expect(writer.calls).toHaveLength(1);
  });
});

describe("runFreedomRequest timeouts", () => {
  it("converts underlying timeouts into FreedomRequestTimeoutError", async () => {
    await expect(
      runFreedomRequest(
        async () => {
          const error = new Error("Timeout 30000ms exceeded");
          error.name = "TimeoutError";
          throw error;
        },
        { method: "PATCH", path: "/filter_lists/1", timeoutMs: 30_000, warnAfterMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(FreedomRequestTimeoutError);
  });

  it("does not treat request timeouts as blindly retryable writer errors", () => {
    expect(
      isRetryableWriterError(new FreedomRequestTimeoutError("PATCH", "/filter_lists/1", 30_000)),
    ).toBe(false);
    expect(isRetryableWriterError(new FreedomHttpError(500))).toBe(true);
  });
});

describe("AdaptiveBatchPacer", () => {
  it("escalates pauses and eventually signals abort", async () => {
    const sleeps: number[] = [];
    const pacer = new AdaptiveBatchPacer({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(pacer.recordTransientFailure()).toBe(false);
    await pacer.delayBeforeNextBatch();
    expect(sleeps[0]).toBe(10_000);

    expect(pacer.recordTransientFailure()).toBe(false);
    await pacer.delayBeforeNextBatch();
    expect(sleeps[1]).toBe(30_000);

    expect(pacer.recordTransientFailure()).toBe(true);
    expect(pacer.shouldAbort()).toBe(true);
  });
});
