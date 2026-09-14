/**
 * Poll until GET /filter_lists/ recovers, then run the post-cleanup validation sequence:
 * auth status → inspect → small sharded dry-run → small live fixture → delete fixtures.
 *
 *   npx tsx scripts/wait-and-validate-after-cleanup.ts
 *   npx tsx scripts/wait-and-validate-after-cleanup.ts --timeout-minutes 90
 */
import { writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FREEDOM_FILTER_LISTS_URL, FREEDOM_ORIGIN, FREEDOM_HOME_URL } from "../src/freedom/auth.js";
import {
  closeFreedomContext,
  openFreedomContext,
  probeAuthStatusDetails,
} from "../src/freedom/client.js";
import { formatAuthStatusReport } from "../src/freedom/auth.js";
import { readCsrfToken } from "../src/freedom/csrf.js";
import { HttpFreedomWriter, buildAddDomainsHeaders } from "../src/freedom/http-writer.js";
import { HttpFreedomListCreator } from "../src/freedom/list-creator.js";
import { getFilterLists } from "../src/freedom/reader.js";
import {
  buildShardedSyncPlan,
  discoverManagedShards,
  formatShardedPlanReport,
} from "../src/sync/shards.js";
import { runShardedAdditiveSync, verifyShardedAdditiveSync } from "../src/sync/sync.js";
import { createLogger } from "../src/utils/logger.js";

function timeoutMinutes(): number {
  const idx = process.argv.indexOf("--timeout-minutes");
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 90;
}

async function filterListsHealthy(context: import("playwright").BrowserContext): Promise<boolean> {
  const res = await context.request.get(FREEDOM_FILTER_LISTS_URL, {
    failOnStatusCode: false,
    timeout: 60_000,
  });
  return res.ok();
}

async function main(): Promise<void> {
  const logger = createLogger();
  const deadline = Date.now() + timeoutMinutes() * 60_000;

  logger.info("Waiting for GET /filter_lists/ to recover after oversized-list cleanup…");
  logger.info("Delete the oversized list in the Freedom UI if you have not already.");
  logger.info("");

  // Headed browser for manual cleanup; API polling uses a separate context.
  const ui = await openFreedomContext({ headed: true });
  const page = ui.pages()[0] ?? (await ui.newPage());
  await page.goto(FREEDOM_HOME_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  logger.info("Freedom browser opened for manual delete. Leave it open while this script polls.");
  logger.info("");

  let recovered = false;
  while (Date.now() < deadline) {
    const probe = await openFreedomContext({ headed: false });
    try {
      const ok = await filterListsHealthy(probe);
      const status = (await probe.request.get(FREEDOM_FILTER_LISTS_URL, {
        failOnStatusCode: false,
        timeout: 60_000,
      })).status();
      logger.info(`[poll] GET /filter_lists/ -> ${status}`);
      if (ok) {
        recovered = true;
        break;
      }
    } finally {
      await closeFreedomContext(probe);
    }
    await sleep(20_000);
  }

  if (!recovered) {
    logger.error("Timed out waiting for GET /filter_lists/ recovery.");
    await closeFreedomContext(ui);
    process.exitCode = 1;
    return;
  }

  logger.info("");
  logger.info("Collection read recovered. Running validation sequence…");
  logger.info("");

  // 1. auth status
  const auth = await probeAuthStatusDetails();
  logger.info(formatAuthStatusReport(auth.status, {
    ...(auth.listsHealthy === false ? { listsHealthy: false } : {}),
  }));
  logger.info("");

  const context = await openFreedomContext({ headed: false });
  try {
    // 2. inspect
    const lists = await getFilterLists(context);
    logger.info(`inspect: ${lists.length} filter list(s)`);
    for (const list of lists.slice(0, 30)) {
      logger.info(`  ${list.id}\t${list.count_websites}\t${list.name}`);
    }
    if (lists.length > 30) {
      logger.info(`  … ${lists.length - 30} more`);
    }
    logger.info("");

    // 3–5. small sharded dry-run + live fixture + cleanup
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const baseName = `FLS ShardFix ${stamp}`;
    const domains = Array.from({ length: 12 }, (_, i) => `fls-shardfix-${stamp}-${i}.example.com`);

    const dir = await mkdtemp(path.join(os.tmpdir(), "fls-fixture-"));
    const sourceFile = path.join(dir, "domains.txt");
    await writeFile(sourceFile, `${domains.join("\n")}\n`, "utf8");

    const dryPlan = buildShardedSyncPlan({
      mode: "additive",
      dryRun: true,
      sourceUrl: sourceFile,
      sourceHash: "fixture",
      sourceDomains: domains,
      baseName,
      shardSize: 5,
      allLists: lists,
    });
    logger.info("Small sharded dry-run:");
    logger.info(formatShardedPlanReport(dryPlan));
    logger.info("");

    const livePlan = buildShardedSyncPlan({
      mode: "additive",
      dryRun: false,
      sourceUrl: sourceFile,
      sourceHash: "fixture",
      sourceDomains: domains,
      baseName,
      shardSize: 5,
      allLists: lists,
    });
    logger.info("Small live sharded fixture…");
    const writer = HttpFreedomWriter.fromContext(context, { logger });
    const listCreator = HttpFreedomListCreator.fromContext(context, { logger });
    const result = await runShardedAdditiveSync({
      plan: livePlan,
      writer,
      listCreator,
      logger,
      batchSize: 50,
    });
    logger.info(
      `Sync result: added=${result.added} batches=${result.batchesSucceeded}/${result.batchesAttempted}`,
    );

    const fresh = await getFilterLists(context);
    const shards = discoverManagedShards(fresh, baseName);
    const verification = verifyShardedAdditiveSync({
      sourceDomains: domains,
      shards,
    });
    logger.info(
      `Verify: present=${verification.presentAcrossShards} missing=${verification.stillMissing} shards=${shards.length}`,
    );
    if (verification.stillMissing > 0) {
      throw new Error("Fixture verification failed: domains still missing.");
    }

    const csrf = await readCsrfToken(context);
    for (const shard of shards) {
      const del = await context.request.delete(`${FREEDOM_ORIGIN}/filter_lists/${shard.id}`, {
        headers: buildAddDomainsHeaders(csrf),
        failOnStatusCode: false,
        timeout: 30_000,
      });
      logger.info(`Deleted fixture shard ${shard.name} (${shard.id}) -> ${del.status()}`);
    }

    logger.info("");
    logger.info("Validation sequence complete.");
    logger.info("Next (manual): full rebuild dry-run against your real source when ready.");
  } finally {
    await closeFreedomContext(context);
    await closeFreedomContext(ui);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
