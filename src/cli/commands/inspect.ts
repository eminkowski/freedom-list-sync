import type { Command } from "commander";

import { isFreedomSessionCliError } from "../../freedom/auth.js";
import { closeFreedomContext, requireAuthenticatedSession } from "../../freedom/client.js";
import { FreedomFilterListsUnavailableError } from "../../freedom/errors.js";
import { findFilterList, getFilterLists, listDomains } from "../../freedom/reader.js";
import { createLogger } from "../../utils/logger.js";
import { formatNumber } from "../../sync/sync.js";

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect")
    .description("List Freedom blocklists available to the authenticated account")
    .option("--list <nameOrId>", "Inspect a specific Freedom blocklist")
    .option("--domains", "Print domains for the selected list", false)
    .action(async (options: { list?: string; domains?: boolean }) => {
      const logger = createLogger();
      let context;
      try {
        context = await requireAuthenticatedSession({ headed: false });
      } catch (error) {
        if (
          isFreedomSessionCliError(error) ||
          error instanceof FreedomFilterListsUnavailableError
        ) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      try {
        if (options.list) {
          const list = await findFilterList(context, options.list);
          logger.info(`ID:       ${list.id}`);
          logger.info(`Name:     ${list.name}`);
          logger.info(`Websites: ${formatNumber(list.count_websites)}`);
          logger.info(`Filters:  ${formatNumber(list.custom_filters.length)}`);

          if (options.domains) {
            logger.info("");
            logger.info("Domains");
            for (const domain of listDomains(list)) {
              logger.info(domain);
            }
          }
          return;
        }

        const lists = await getFilterLists(context);
        logger.info("Freedom blocklists");
        logger.info("");
        logger.info(formatTable(lists));

        if (options.domains) {
          logger.warn("Use --list <nameOrId> together with --domains to print domains.");
        }
      } catch (error) {
        if (
          isFreedomSessionCliError(error) ||
          error instanceof FreedomFilterListsUnavailableError
        ) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      } finally {
        await closeFreedomContext(context);
      }
    });
}

function formatTable(lists: Array<{ id: number; name: string; count_websites: number }>): string {
  const idWidth = Math.max(2, ...lists.map((list) => String(list.id).length));
  const nameWidth = Math.max(4, ...lists.map((list) => list.name.length));
  const countWidth = Math.max(8, ...lists.map((list) => formatNumber(list.count_websites).length));

  const header = [
    "ID".padEnd(idWidth),
    "Name".padEnd(nameWidth),
    "Websites".padStart(countWidth),
  ].join("  ");

  const rows = lists.map((list) =>
    [
      String(list.id).padEnd(idWidth),
      list.name.padEnd(nameWidth),
      formatNumber(list.count_websites).padStart(countWidth),
    ].join("  "),
  );

  return [header, ...rows].join("\n");
}
