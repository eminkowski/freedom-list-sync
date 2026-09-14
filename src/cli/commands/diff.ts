import type { Command } from "commander";

import { isFreedomSessionCliError } from "../../freedom/auth.js";
import { closeFreedomContext, requireAuthenticatedSession } from "../../freedom/client.js";
import { FreedomFilterListsUnavailableError } from "../../freedom/errors.js";
import { findFilterList, listDomains } from "../../freedom/reader.js";
import {
  AmbiguousSourceFormatError,
  StrictParseError,
  UnsupportedSourceFormatError,
} from "../../sources/errors.js";
import { loadSource } from "../../sources/fetch.js";
import { SourceTooLargeError } from "../../sources/limits.js";
import { logParsedSourceStats } from "../../sources/stats.js";
import { diffDomains } from "../../sync/diff.js";
import { formatNumber } from "../../sync/sync.js";
import { createLogger } from "../../utils/logger.js";
import { buildParseOptions, parseSourceFormat, resolveSourceInput } from "../source-options.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Compare a remote blocklist against a Freedom blocklist")
    .option("--source <url>", "Remote blocklist URL")
    .option("--source-file <path>", "Local blocklist file path")
    .requiredOption("--list <nameOrId>", "Freedom blocklist name or ID")
    .option("--source-format <format>", "hosts | domains | csv | json | auto", "auto")
    .option("--domain-column <nameOrIndex>", "CSV domain column header name or 0-based index")
    .option("--domain-field <name>", "JSON object field containing the domain")
    .option("--strict", "Fail if any meaningful source line cannot be parsed", false)
    .option("--verbose", "Print every addition and removal", false)
    .option("--limit <n>", "How many sample changes to print", "10")
    .action(
      async (options: {
        source?: string;
        sourceFile?: string;
        list: string;
        sourceFormat: string;
        domainColumn?: string;
        domainField?: string;
        strict?: boolean;
        verbose?: boolean;
        limit: string;
      }) => {
        const logger = createLogger();
        const format = parseSourceFormat(options.sourceFormat);
        const parseOptions = buildParseOptions({
          ...(options.strict === true ? { strict: true } : {}),
          ...(options.domainColumn !== undefined ? { domainColumn: options.domainColumn } : {}),
          ...(options.domainField !== undefined ? { domainField: options.domainField } : {}),
        });
        const sampleLimit = Number(options.limit);

        let sourceInput: { sourceUrl?: string; sourceFile?: string };
        try {
          sourceInput = resolveSourceInput({
            ...(options.source !== undefined ? { source: options.source } : {}),
            ...(options.sourceFile !== undefined ? { sourceFile: options.sourceFile } : {}),
          });
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
        }

        let source;
        try {
          source = await loadSource({
            ...sourceInput,
            format,
            options: parseOptions,
          });
        } catch (error) {
          if (
            error instanceof AmbiguousSourceFormatError ||
            error instanceof UnsupportedSourceFormatError ||
            error instanceof StrictParseError ||
            error instanceof SourceTooLargeError ||
            (error instanceof Error &&
              (/Failed to fetch source/.test(error.message) ||
                /Failed to read source file/.test(error.message) ||
                /Refusing source with content-type/.test(error.message) ||
                /JSON /.test(error.message) ||
                /CSV /.test(error.message)))
          ) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
            return;
          }
          throw error;
        }

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
          const list = await findFilterList(context, options.list);
          const freedomDomains = listDomains(list);
          const diff = diffDomains(source.domains, freedomDomains);

          logParsedSourceStats(logger, source);
          logger.info(`Freedom domains:                ${formatNumber(freedomDomains.length)}`);
          logger.info(`Already present:                ${formatNumber(diff.unchangedCount)}`);
          logger.info(`To add:                         ${formatNumber(diff.additions.length)}`);
          logger.info(`Only in Freedom:                ${formatNumber(diff.removals.length)}`);

          printSamples(logger, "Additions", diff.additions, options.verbose === true, sampleLimit);
          printSamples(logger, "Removals", diff.removals, options.verbose === true, sampleLimit);
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
      },
    );
}

function printSamples(
  logger: { info(message: string): void },
  title: string,
  values: string[],
  verbose: boolean,
  limit: number,
): void {
  if (values.length === 0) {
    return;
  }

  logger.info("");
  logger.info(title);

  const shown = verbose ? values : values.slice(0, Math.max(0, limit));
  for (const value of shown) {
    logger.info(`  ${value}`);
  }

  if (!verbose && values.length > shown.length) {
    logger.info(`  ... and ${formatNumber(values.length - shown.length)} more`);
  }
}
