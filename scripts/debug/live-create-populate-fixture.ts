/**
 * Live fixture: create a throwaway list, add a few domains, then delete it.
 * Does not require healthy GET /filter_lists/.
 *
 *   npx tsx scripts/live-create-populate-fixture.ts
 */
import { FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import { closeFreedomContext, openFreedomContext } from "../../src/freedom/client.js";
import { readCsrfToken } from "../../src/freedom/csrf.js";
import { HttpFreedomWriter, buildAddDomainsHeaders } from "../../src/freedom/http-writer.js";
import { HttpFreedomListCreator } from "../../src/freedom/list-creator.js";
import { createLogger } from "../../src/utils/logger.js";

async function main(): Promise<void> {
  const logger = createLogger();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const baseName = `FLS Fixture ${stamp}`;
  const domains = [
    `fls-fixture-a-${stamp}.example.com`,
    `fls-fixture-b-${stamp}.example.com`,
    `fls-fixture-c-${stamp}.example.com`,
  ];

  const context = await openFreedomContext({ headed: false });
  try {
    const creator = HttpFreedomListCreator.fromContext(context, { logger });
    const writer = HttpFreedomWriter.fromContext(context, { logger });

    logger.info(`Creating: ${baseName}`);
    const created = await creator.createFilterList(baseName);
    logger.info(`Created id=${created.id} name=${JSON.stringify(created.name)}`);

    logger.info(`Adding ${domains.length} domains…`);
    const result = await writer.addDomains(created.id, domains);
    logger.info(
      `Write result: requested=${result.requested} addedCount=${result.addedCount ?? "n/a"}`,
    );

    // Create a second shard-style name to prove repeated creates.
    const shard2 = `${baseName} 2`;
    logger.info(`Creating shard: ${shard2}`);
    const created2 = await creator.createFilterList(shard2);
    logger.info(`Created id=${created2.id}`);
    await writer.addDomains(created2.id, [`fls-fixture-d-${stamp}.example.com`]);

    const csrf = await readCsrfToken(context);
    for (const list of [created, created2]) {
      const del = await context.request.delete(`${FREEDOM_ORIGIN}/filter_lists/${list.id}`, {
        headers: buildAddDomainsHeaders(csrf),
        failOnStatusCode: false,
        timeout: 30_000,
      });
      logger.info(`Cleanup DELETE ${list.id} -> ${del.status()}`);
    }

    logger.info("");
    logger.info("Live create + populate fixture OK.");
  } finally {
    await closeFreedomContext(context);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
