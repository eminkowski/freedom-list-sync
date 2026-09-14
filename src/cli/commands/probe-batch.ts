import type { Command } from "commander";

import { isFreedomSessionCliError } from "../../freedom/auth.js";
import { FreedomAuthenticationError } from "../../freedom/errors.js";
import {
  closeFreedomContext,
  requireAuthenticatedSession,
} from "../../freedom/client.js";
import { HttpFreedomWriter } from "../../freedom/http-writer.js";
import {
  findFilterList,
  getFilterLists,
  listDomains,
  resolveFilterList,
} from "../../freedom/reader.js";
import { createLogger } from "../../utils/logger.js";

/**
 * Probe Freedom PATCH batch sizes with unique probe-N.example.com domains.
 * Intended for a throwaway / low-importance list such as "Social Media".
 */
export function registerProbeBatchCommand(program: Command): void {
  program
    .command("debug:probe-batch")
    .description("Probe Freedom PATCH batch sizes (writes unique probe domains)")
    .requiredOption("--list <nameOrId>", "Freedom blocklist to probe")
    .option(
      "--sizes <csv>",
      "Comma-separated batch sizes to try",
      "10,25,50,75,100",
    )
    .option("--prefix <text>", "Domain prefix for probe hosts", "probe")
    .action(async (options: { list: string; sizes: string; prefix: string }) => {
      const logger = createLogger();
      const sizes = options.sizes
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (sizes.length === 0) {
        throw new Error(`Invalid --sizes: ${options.sizes}`);
      }

      const runId = Date.now().toString(36);
      let context;
      try {
        context = await requireAuthenticatedSession({ headed: false });
      } catch (error) {
        if (isFreedomSessionCliError(error) || error instanceof FreedomAuthenticationError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      try {
        const list = await findFilterList(context, options.list);
        const writer = HttpFreedomWriter.fromContext(context);

        logger.info(`Probing batch sizes against "${list.name}" (${list.id})`);
        logger.info(`Prefix: ${options.prefix}-${runId}-N.example.com`);
        logger.info("");

        let domainCounter = 1;
        for (const size of sizes) {
          const domains = Array.from({ length: size }, () => {
            const domain = `${options.prefix}-${runId}-${String(domainCounter).padStart(3, "0")}.example.com`;
            domainCounter += 1;
            return domain;
          });

          const started = Date.now();
          try {
            const result = await writer.addDomains(list.id, domains);
            const ms = Date.now() - started;
            const added = result.addedCount ?? result.requested;
            logger.info(
              `size=${String(size).padStart(3)}  ok  ${ms}ms  requested=${result.requested} added≈${added}`,
            );
          } catch (error) {
            const ms = Date.now() - started;
            const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
            logger.error(`size=${String(size).padStart(3)}  FAIL  ${ms}ms  ${message}`);
            process.exitCode = 1;
            break;
          }
        }

        try {
          const lists = await getFilterLists(context);
          const refreshed = resolveFilterList(lists, String(list.id));
          logger.info("");
          logger.info(
            `List now has ${listDomains(refreshed).length} domains (was ${listDomains(list).length})`,
          );
        } catch (error) {
          if (isFreedomSessionCliError(error) || error instanceof FreedomAuthenticationError) {
            console.error(error.message);
            process.exitCode = 1;
            return;
          }
          throw error;
        }
      } finally {
        await closeFreedomContext(context);
      }
    });
}
