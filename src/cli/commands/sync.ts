import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { Command } from "commander";

import { isFreedomSessionCliError } from "../../freedom/auth.js";
import {
  FreedomAuthenticationError,
  FreedomFilterListsUnavailableError,
} from "../../freedom/errors.js";
import { closeFreedomContext, requireAuthenticatedSession } from "../../freedom/client.js";
import { HttpFreedomWriter, MAX_BATCH_SIZE } from "../../freedom/http-writer.js";
import { HttpFreedomListCreator } from "../../freedom/list-creator.js";
import { getFilterLists, resolveFilterList } from "../../freedom/reader.js";
import {
  AmbiguousSourceFormatError,
  StrictParseError,
  UnsupportedSourceFormatError,
} from "../../sources/errors.js";
import { loadSource } from "../../sources/fetch.js";
import { SourceTooLargeError } from "../../sources/limits.js";
import { logParsedSourceStats } from "../../sources/stats.js";
import { buildParseOptions, parseSourceFormat, resolveSourceInput } from "../source-options.js";
import { type SyncMode } from "../../sync/checkpoint.js";
import {
  AdditionalShardsRequiredError,
  DEFAULT_SHARD_SIZE,
  MAX_SHARD_SIZE,
  buildShardedSyncPlan,
  discoverManagedShards,
  formatShardedPlanReport,
  parseShardSize,
  resolveLogicalBaseName,
  ShardSizeError,
} from "../../sync/shards.js";
import {
  EmptySourceError,
  formatNumber,
  LARGE_SYNC_CONFIRMATION_THRESHOLD,
  MirrorRemovalsUnsupportedError,
  parseBatchSize,
  runShardedAdditiveSync,
  SyncInterruptedError,
  verifyShardedAdditiveSync,
} from "../../sync/sync.js";
import { createLogger } from "../../utils/logger.js";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Synchronize a remote blocklist into Freedom blocklist shard(s)")
    .option("--source <url>", "Remote blocklist URL")
    .option("--source-file <path>", "Local blocklist file path")
    .requiredOption("--list <nameOrId>", "Logical Freedom blocklist base name or ID")
    .option("--source-format <format>", "hosts | domains | csv | json | auto", "auto")
    .option("--domain-column <nameOrIndex>", "CSV domain column header name or 0-based index")
    .option("--domain-field <name>", "JSON object field containing the domain")
    .option("--mode <mode>", "additive | mirror", "additive")
    .option(
      "--shard-size <n>",
      `Max domains per Freedom list (default ${DEFAULT_SHARD_SIZE}, safe max ${MAX_SHARD_SIZE})`,
      String(DEFAULT_SHARD_SIZE),
    )
    .option(
      "--allow-unsafe-shard-size",
      "Allow --shard-size outside the safe 100–5000 range",
      false,
    )
    .option("--batch-size <n>", `Domains per PATCH (default 50, max ${MAX_BATCH_SIZE})`, "50")
    .option("--strict", "Fail if any meaningful source line cannot be parsed", false)
    .option("--dry-run", "Show the planned changes without modifying Freedom", false)
    .option("--yes", "Skip confirmation for large additive syncs", false)
    .option("--verbose", "Print every domain being added", false)
    .action(
      async (options: {
        source?: string;
        sourceFile?: string;
        list: string;
        sourceFormat: string;
        domainColumn?: string;
        domainField?: string;
        mode: string;
        shardSize: string;
        allowUnsafeShardSize?: boolean;
        batchSize: string;
        strict?: boolean;
        dryRun?: boolean;
        yes?: boolean;
        verbose?: boolean;
      }) => {
        const logger = createLogger();
        const mode = parseMode(options.mode);
        const format = parseSourceFormat(options.sourceFormat);
        const parseOptions = buildParseOptions({
          ...(options.strict === true ? { strict: true } : {}),
          ...(options.domainColumn !== undefined ? { domainColumn: options.domainColumn } : {}),
          ...(options.domainField !== undefined ? { domainField: options.domainField } : {}),
        });
        const dryRun = options.dryRun === true;
        const batchSize = parseBatchSize(options.batchSize);
        const verbose = options.verbose === true;

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

        let shardSize: number;
        try {
          shardSize = parseShardSize(options.shardSize, {
            allowUnsafe: options.allowUnsafeShardSize === true,
          });
        } catch (error) {
          if (error instanceof ShardSizeError) {
            console.error(error.message);
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        let source;
        try {
          source = await loadSource({
            ...sourceInput,
            format,
            options: parseOptions,
          });
        } catch (error) {
          handleSourceError(error);
          return;
        }

        if (source.domains.length === 0) {
          console.error(
            new EmptySourceError("Remote source parsed as empty. Aborting for safety.").message,
          );
          process.exitCode = 1;
          return;
        }

        let context;
        try {
          context = await requireAuthenticatedSession({ headed: false });
        } catch (error) {
          if (
            isFreedomSessionCliError(error) ||
            error instanceof FreedomAuthenticationError ||
            error instanceof FreedomFilterListsUnavailableError
          ) {
            console.error(error.message);
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        try {
          const lists = await getFilterLists(context);
          const baseName = resolveLogicalBaseName(lists, options.list);
          const plan = buildShardedSyncPlan({
            mode,
            dryRun,
            sourceUrl: source.url,
            sourceHash: source.contentHash,
            sourceDomains: source.domains,
            baseName,
            shardSize,
            allLists: lists,
          });

          if (mode === "mirror" && plan.diff.removals.length > 0) {
            logger.warn(new MirrorRemovalsUnsupportedError(plan.diff.removals.length).message);
            logger.warn("");
          }

          if (dryRun) {
            logger.info("DRY RUN");
            logger.info("");
            logger.info(formatShardedPlanReport(plan));
            logger.info("");
            logParsedSourceStats(logger, source);
            logger.info("");
            logger.info("No changes were made.");
            return;
          }

          if (plan.domainsToAdd.length === 0) {
            logger.info("Already in sync.");
            return;
          }

          if (
            plan.domainsToAdd.length > LARGE_SYNC_CONFIRMATION_THRESHOLD &&
            options.yes !== true
          ) {
            const confirmed = await confirmLargeSync(
              `This sync will add ${formatNumber(plan.domainsToAdd.length)} domains ` +
                `across logical target "${baseName}" (${formatNumber(plan.allocations.length)} shard write(s)).\n\nContinue? (y/N) `,
            );
            if (!confirmed) {
              logger.info("Aborted.");
              process.exitCode = 1;
              return;
            }
          }

          logger.info("");
          logParsedSourceStats(logger, source);
          logger.info("");
          logger.info(formatShardedPlanReport(plan));
          logger.info("");

          const writer = HttpFreedomWriter.fromContext(context, { logger });
          const listCreator = HttpFreedomListCreator.fromContext(context, { logger });

          const result = await runShardedAdditiveSync({
            plan,
            writer,
            listCreator,
            logger,
            batchSize,
            verbose,
            loadList: async (listId) => {
              const fresh = await getFilterLists(context);
              return resolveFilterList(fresh, String(listId));
            },
          });

          const verifiedLists = await getFilterLists(context);
          const verifiedShards = discoverManagedShards(verifiedLists, baseName);
          const verification = verifyShardedAdditiveSync({
            sourceDomains: source.domains,
            shards: verifiedShards,
          });

          logger.info("Sync complete.");
          logger.info("");
          logger.info(`Logical target: ${baseName}`);
          logger.info(`Managed shards: ${formatNumber(verifiedShards.length)}`);
          logger.info(`Source domains: ${formatNumber(source.domains.length)}`);
          logger.info(`Present across shards: ${formatNumber(verification.presentAcrossShards)}`);
          logger.info(`Still missing: ${formatNumber(verification.stillMissing)}`);
          logger.info(`Only in Freedom: ${formatNumber(verification.onlyInFreedom)}`);
          logger.info(`Added this run: ${formatNumber(result.added)}`);

          if (verification.stillMissing > 0) {
            logger.error("");
            logger.error("Post-sync verification incomplete: domains are still missing.");
            process.exitCode = 1;
          }
        } catch (error) {
          if (
            isFreedomSessionCliError(error) ||
            error instanceof FreedomAuthenticationError ||
            error instanceof FreedomFilterListsUnavailableError ||
            error instanceof AdditionalShardsRequiredError ||
            error instanceof EmptySourceError ||
            error instanceof SyncInterruptedError
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

function handleSourceError(error: unknown): void {
  if (
    error instanceof AmbiguousSourceFormatError ||
    error instanceof UnsupportedSourceFormatError ||
    error instanceof StrictParseError ||
    error instanceof SourceTooLargeError
  ) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error && /Provide exactly one of --source/.test(error.message)) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (
    error instanceof Error &&
    (/Failed to fetch source/.test(error.message) ||
      /Failed to read source file/.test(error.message) ||
      /Refusing source with content-type/.test(error.message) ||
      /Failed to parse CSV source/.test(error.message) ||
      /JSON field /.test(error.message) ||
      /JSON object/.test(error.message) ||
      /CSV /.test(error.message))
  ) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
}

async function confirmLargeSync(prompt: string): Promise<boolean> {
  if (!input.isTTY) {
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function parseMode(value: string): SyncMode {
  if (value === "additive" || value === "mirror") {
    return value;
  }
  throw new Error(`Invalid --mode: ${value}`);
}
