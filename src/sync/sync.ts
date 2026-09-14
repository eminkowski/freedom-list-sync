import {
  FreedomHttpError,
  FreedomRequestTimeoutError,
} from "../freedom/errors.js";
import type { FreedomFilterList } from "../freedom/types.js";
import type { AddDomainsResult, FreedomWriter } from "../freedom/writer.js";
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from "../freedom/http-writer.js";
import { listDomains } from "../freedom/reader.js";
import { chunk } from "../utils/batch.js";
import { createLogger, type Logger } from "../utils/logger.js";
import {
  createCheckpoint,
  markDomainsComplete,
  type CheckpointState,
  type SyncMode,
} from "./checkpoint.js";
import { diffDomains, type DomainDiff } from "./diff.js";
import { AdaptiveBatchPacer } from "./pacer.js";
import {
  AdditionalShardsRequiredError,
  type ShardedSyncPlan,
  unionManagedDomains,
} from "./shards.js";
import {
  FilterListCreationUnsupportedError,
  type FreedomListCreator,
} from "../freedom/list-creator.js";

export const FREEDOM_BATCH_SIZE = DEFAULT_BATCH_SIZE;
export const EMPTY_SOURCE_ABORT_THRESHOLD = 100;
export const LARGE_SYNC_CONFIRMATION_THRESHOLD = 1000;

export interface SyncPlan {
  mode: SyncMode;
  dryRun: boolean;
  sourceUrl: string;
  sourceHash: string;
  sourceDomainCount: number;
  list: FreedomFilterList;
  diff: DomainDiff;
  domainsToAdd: string[];
}

export interface SyncResult {
  added: number;
  failed: number;
  alreadyPresent: number;
  removalsSkipped: number;
  dryRun: boolean;
  batchesAttempted: number;
  batchesSucceeded: number;
  finalFreedomCount?: number;
  stillMissing?: number;
  onlyInFreedom?: number;
  incompleteVerification?: boolean;
}

export interface ShardedSyncResult extends SyncResult {
  managedShardCount: number;
  presentAcrossShards?: number;
}

export interface SyncInterruptedErrorDetails {
  completed: number;
  remaining: number;
  failedBatch: number;
  totalBatches: number;
  reason: string;
}

export class SyncInterruptedError extends Error {
  readonly details: SyncInterruptedErrorDetails;

  constructor(details: SyncInterruptedErrorDetails) {
    super(
      [
        "Sync interrupted.",
        "",
        `Completed: ${formatNumber(details.completed)}`,
        `Remaining: ${formatNumber(details.remaining)}`,
        "",
        `Failed batch: ${formatNumber(details.failedBatch)} / ${formatNumber(details.totalBatches)}`,
        `Reason: ${details.reason}`,
        "",
        "Progress was preserved.",
        "Run the same command again to resume safely.",
      ].join("\n"),
    );
    this.name = "SyncInterruptedError";
    this.details = details;
  }
}

export function buildSyncPlan(input: {
  mode: SyncMode;
  dryRun: boolean;
  sourceUrl: string;
  sourceHash: string;
  sourceDomains: string[];
  list: FreedomFilterList;
  previousSourceDomainCount?: number;
}): SyncPlan {
  const { sourceDomains, list, mode, previousSourceDomainCount } = input;

  if (sourceDomains.length === 0) {
    const previouslyLarge =
      previousSourceDomainCount !== undefined &&
      previousSourceDomainCount >= EMPTY_SOURCE_ABORT_THRESHOLD;
    const message = previouslyLarge
      ? `Remote source parsed as empty, but a previous run saw ${previousSourceDomainCount} domains. Aborting for safety.`
      : "Remote source parsed as empty. Aborting for safety.";
    throw new EmptySourceError(message);
  }

  const freedomDomains = list.custom_filters.map((filter) => filter.id);
  const diff = diffDomains(sourceDomains, freedomDomains);

  return {
    mode,
    dryRun: input.dryRun,
    sourceUrl: input.sourceUrl,
    sourceHash: input.sourceHash,
    sourceDomainCount: sourceDomains.length,
    list,
    diff,
    domainsToAdd: diff.additions,
  };
}

export class EmptySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptySourceError";
  }
}

export class MirrorRemovalsUnsupportedError extends Error {
  readonly removalCount: number;

  constructor(removalCount: number) {
    super(
      `Mirror mode requested ${removalCount} removal(s), but Freedom removals are not supported yet. ` +
        `Additions can still proceed; removals were skipped.`,
    );
    this.name = "MirrorRemovalsUnsupportedError";
    this.removalCount = removalCount;
  }
}

export interface TimedOutBatchResolution {
  /** Domains from the batch confirmed present in Freedom. */
  committed: string[];
  /** Domains still missing after the fresh GET. */
  stillMissing: string[];
}

/**
 * After a PATCH timeout, Freedom is authoritative.
 * Recompute which domains from the timed-out batch still need to be sent.
 */
export function resolveTimedOutBatch(
  batch: readonly string[],
  list: FreedomFilterList,
): TimedOutBatchResolution {
  const present = new Set(listDomains(list));
  const committed: string[] = [];
  const stillMissing: string[] = [];
  for (const domain of batch) {
    if (present.has(domain)) {
      committed.push(domain);
    } else {
      stillMissing.push(domain);
    }
  }
  return { committed, stillMissing };
}

/**
 * Run additive sync across a logical sharded target.
 * Existing shard capacity is filled first. Missing shards are created via
 * `listCreator` when provided; otherwise sync stops with names to create manually.
 */
export async function runShardedAdditiveSync(input: {
  plan: ShardedSyncPlan;
  writer: FreedomWriter;
  listCreator?: FreedomListCreator;
  logger?: Logger;
  batchSize?: number;
  verbose?: boolean;
  delayBetweenBatches?: boolean;
  loadList?: (listId: number) => Promise<FreedomFilterList>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ShardedSyncResult> {
  const logger = input.logger ?? createLogger();
  const { plan } = input;

  if (plan.dryRun) {
    return {
      added: 0,
      failed: 0,
      alreadyPresent: plan.diff.unchangedCount,
      removalsSkipped: plan.mode === "mirror" ? plan.diff.removals.length : 0,
      dryRun: true,
      batchesAttempted: 0,
      batchesSucceeded: 0,
      managedShardCount: plan.target.shards.length,
    };
  }

  if (plan.domainsToAdd.length === 0) {
    logger.info("Already in sync.");
    return {
      added: 0,
      failed: 0,
      alreadyPresent: plan.diff.unchangedCount,
      removalsSkipped: plan.mode === "mirror" ? plan.diff.removals.length : 0,
      dryRun: false,
      batchesAttempted: 0,
      batchesSucceeded: 0,
      managedShardCount: plan.target.shards.length,
    };
  }

  let added = 0;
  let batchesAttempted = 0;
  let batchesSucceeded = 0;
  let managedShardCount = plan.target.shards.length;

  for (let index = 0; index < plan.allocations.length; index += 1) {
    const allocation = plan.allocations[index]!;
    if (allocation.domains.length === 0) {
      continue;
    }

    let list = allocation.list;
    if (allocation.isNew || !list) {
      list = await createShardOrThrow({
        name: allocation.name,
        remainingNewNames: plan.allocations
          .slice(index)
          .filter((item) => item.isNew)
          .map((item) => item.name),
        logger,
        ...(input.listCreator ? { listCreator: input.listCreator } : {}),
      });
      managedShardCount += 1;
    }

    const shardPlan: SyncPlan = {
      mode: plan.mode,
      dryRun: false,
      sourceUrl: plan.sourceUrl,
      sourceHash: plan.sourceHash,
      sourceDomainCount: plan.sourceDomainCount,
      list,
      diff: {
        additions: allocation.domains,
        removals: [],
        unchangedCount: 0,
      },
      domainsToAdd: allocation.domains,
    };

    const checkpoint = createCheckpoint({
      source: plan.sourceUrl,
      targetListId: list.id,
      mode: plan.mode,
      sourceHash: plan.sourceHash,
    });

    logger.info(`Shard: ${list.name} (${list.id})`);
    logger.info("");

    const result = await runAdditiveSync({
      plan: shardPlan,
      writer: input.writer,
      logger,
      checkpoint,
      ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
      ...(input.verbose !== undefined ? { verbose: input.verbose } : {}),
      ...(input.delayBetweenBatches !== undefined
        ? { delayBetweenBatches: input.delayBetweenBatches }
        : {}),
      ...(input.loadList
        ? {
            loadList: async () => {
              const currentId = list!.id;
              return input.loadList!(currentId);
            },
          }
        : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });

    added += result.added;
    batchesAttempted += result.batchesAttempted;
    batchesSucceeded += result.batchesSucceeded;
  }

  return {
    added,
    failed: 0,
    alreadyPresent: plan.diff.unchangedCount,
    removalsSkipped: plan.mode === "mirror" ? plan.diff.removals.length : 0,
    dryRun: false,
    batchesAttempted,
    batchesSucceeded,
    managedShardCount,
  };
}

async function createShardOrThrow(input: {
  name: string;
  listCreator?: FreedomListCreator;
  remainingNewNames: string[];
  logger: Logger;
}): Promise<FreedomFilterList> {
  if (!input.listCreator) {
    throw new AdditionalShardsRequiredError(input.remainingNewNames);
  }

  try {
    input.logger.info(`Creating shard list: ${input.name}`);
    const created = await input.listCreator.createFilterList(input.name);
    input.logger.info(`Created ${created.name} (${created.id})`);
    input.logger.info("");
    return created;
  } catch (error) {
    if (error instanceof FilterListCreationUnsupportedError) {
      throw new AdditionalShardsRequiredError(input.remainingNewNames);
    }
    throw error;
  }
}

export function verifyShardedAdditiveSync(input: {
  sourceDomains: readonly string[];
  shards: readonly FreedomFilterList[];
}): {
  presentAcrossShards: number;
  stillMissing: number;
  onlyInFreedom: number;
  missingDomains: string[];
} {
  const union = unionManagedDomains(input.shards);
  const diff = diffDomains(input.sourceDomains, union);
  return {
    presentAcrossShards: input.sourceDomains.length - diff.additions.length,
    stillMissing: diff.additions.length,
    onlyInFreedom: diff.removals.length,
    missingDomains: diff.additions,
  };
}

export async function runAdditiveSync(input: {
  plan: SyncPlan;
  writer: FreedomWriter;
  logger?: Logger;
  checkpoint?: CheckpointState;
  batchSize?: number;
  verbose?: boolean;
  delayBetweenBatches?: boolean;
  /** Fresh Freedom list loader used after PATCH timeouts / recovery. */
  loadList?: () => Promise<FreedomFilterList>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SyncResult> {
  const logger = input.logger ?? createLogger();
  const { plan, writer } = input;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const verbose = input.verbose === true;
  const delayBetweenBatches = input.delayBetweenBatches !== false;
  const pacer = new AdaptiveBatchPacer({
    logger,
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });

  if (plan.dryRun) {
    return {
      added: 0,
      failed: 0,
      alreadyPresent: plan.diff.unchangedCount,
      removalsSkipped: plan.mode === "mirror" ? plan.diff.removals.length : 0,
      dryRun: true,
      batchesAttempted: 0,
      batchesSucceeded: 0,
    };
  }

  if (plan.domainsToAdd.length === 0) {
    logger.info("Already in sync.");
    return {
      added: 0,
      failed: 0,
      alreadyPresent: plan.diff.unchangedCount,
      removalsSkipped: plan.mode === "mirror" ? plan.diff.removals.length : 0,
      dryRun: false,
      batchesAttempted: 0,
      batchesSucceeded: 0,
    };
  }

  let checkpoint =
    input.checkpoint ??
    createCheckpoint({
      source: plan.sourceUrl,
      targetListId: plan.list.id,
      mode: plan.mode,
      sourceHash: plan.sourceHash,
    });

  const completed = new Set(checkpoint.completedDomains);
  const pending = plan.domainsToAdd.filter((domain) => !completed.has(domain));
  const batches = chunk(pending, batchSize);

  let added = 0;

  logger.info(`Target: ${plan.list.name} (${plan.list.id})`);
  logger.info("");
  logger.info(`Source domains:     ${formatNumber(plan.sourceDomainCount)}`);
  logger.info(`Existing domains:   ${formatNumber(plan.list.custom_filters.length)}`);
  logger.info(`Already present:    ${formatNumber(plan.diff.unchangedCount)}`);
  logger.info(`To add:             ${formatNumber(pending.length)}`);
  logger.info("");

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index] ?? [];
    const batchNumber = index + 1;
    const batchStarted = Date.now();

    logger.info(`Batch ${formatNumber(batchNumber)} / ${formatNumber(batches.length)}`);
    logger.info(`Adding ${formatNumber(batch.length)} domains...`);
    if (verbose) {
      for (const domain of batch) {
        logger.info(`  + ${domain}`);
      }
    }

    try {
      const result = await submitBatchWithTimeoutRecovery({
        writer,
        listId: plan.list.id,
        batch,
        logger,
        verbose,
        ...(input.loadList ? { loadList: input.loadList } : {}),
      });

      checkpoint = await markDomainsComplete(checkpoint, batch);
      added += batch.length;
      pacer.recordSuccess();

      logger.info(`Success. (${Date.now() - batchStarted}ms)`);
      if (result.addedCount !== undefined) {
        logger.info(`Count delta reported: ${formatNumber(result.addedCount)}`);
      }
      logger.info("");
      logger.info(`Completed: ${formatNumber(added)} / ${formatNumber(pending.length)}`);
      logger.info(`Remaining: ${formatNumber(pending.length - added)}`);
      logger.info("");
    } catch (error) {
      if (error instanceof FreedomHttpError && isTransientHttpError(error)) {
        const shouldAbort = pacer.recordTransientFailure();
        if (shouldAbort || !delayBetweenBatches) {
          throw interruptFromError({
            error,
            added,
            pendingCount: pending.length,
            batchNumber,
            totalBatches: batches.length,
          });
        }
        // One more pause then abort this run so the next invocation re-diffs.
        await pacer.delayBeforeNextBatch();
        throw interruptFromError({
          error,
          added,
          pendingCount: pending.length,
          batchNumber,
          totalBatches: batches.length,
        });
      }

      throw interruptFromError({
        error,
        added,
        pendingCount: pending.length,
        batchNumber,
        totalBatches: batches.length,
      });
    }

    if (delayBetweenBatches && index < batches.length - 1) {
      await pacer.delayBeforeNextBatch();
    }
  }

  return {
    added,
    failed: 0,
    alreadyPresent: plan.diff.unchangedCount,
    removalsSkipped: plan.mode === "mirror" ? plan.diff.removals.length : 0,
    dryRun: false,
    batchesAttempted: batches.length,
    batchesSucceeded: batches.length,
  };
}

async function submitBatchWithTimeoutRecovery(input: {
  writer: FreedomWriter;
  listId: number;
  batch: string[];
  logger: Logger;
  verbose: boolean;
  loadList?: () => Promise<FreedomFilterList>;
}): Promise<AddDomainsResult> {
  try {
    return await input.writer.addDomains(input.listId, input.batch);
  } catch (error) {
    if (!(error instanceof FreedomRequestTimeoutError)) {
      throw error;
    }

    input.logger.warn(
      "Freedom PATCH timed out. Write outcome is unknown — verifying against a fresh Freedom read...",
    );

    if (!input.loadList) {
      throw new Error(
        "PATCH timed out and no Freedom list loader was provided for recovery. " +
          "Stopping so the next run can re-diff safely.",
      );
    }

    let freshList: FreedomFilterList;
    try {
      freshList = await input.loadList();
    } catch (loadError) {
      const detail =
        loadError instanceof Error ? loadError.message.split("\n")[0] : String(loadError);
      throw new Error(
        `PATCH timed out and Freedom GET is unavailable (${detail}). ` +
          "Stopping without retrying the write. Re-run later to resume from a fresh diff.",
      );
    }

    const resolution = resolveTimedOutBatch(input.batch, freshList);
    input.logger.info(
      `After timeout: ${formatNumber(resolution.committed.length)} committed, ` +
        `${formatNumber(resolution.stillMissing.length)} still missing.`,
    );

    if (resolution.stillMissing.length === 0) {
      return {
        requested: input.batch.length,
        addedCount: resolution.committed.length,
      };
    }

    if (input.verbose) {
      for (const domain of resolution.stillMissing) {
        input.logger.info(`  retry + ${domain}`);
      }
    }

    input.logger.info(
      `Resending only ${formatNumber(resolution.stillMissing.length)} still-missing domain(s)...`,
    );

    // One recovery write of remaining domains only. If this also times out / fails, stop.
    try {
      const retryResult = await input.writer.addDomains(input.listId, resolution.stillMissing);
      return {
        requested: input.batch.length,
        addedCount:
          resolution.committed.length + (retryResult.addedCount ?? resolution.stillMissing.length),
      };
    } catch (retryError) {
      if (retryError instanceof FreedomRequestTimeoutError) {
        throw new Error(
          "Recovery PATCH also timed out after verifying Freedom. " +
            "Stopping so the next run can re-diff safely.",
        );
      }
      throw retryError;
    }
  }
}

function isTransientHttpError(error: FreedomHttpError): boolean {
  return (
    error.status === 429 ||
    error.status === 500 ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504
  );
}

function interruptFromError(input: {
  error: unknown;
  added: number;
  pendingCount: number;
  batchNumber: number;
  totalBatches: number;
}): SyncInterruptedError {
  const reason =
    input.error instanceof Error
      ? (input.error.message.split("\n")[0] ?? "unknown")
      : String(input.error);
  return new SyncInterruptedError({
    completed: input.added,
    remaining: input.pendingCount - input.added,
    failedBatch: input.batchNumber,
    totalBatches: input.totalBatches,
    reason,
  });
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function parseBatchSize(raw: string, fallback = DEFAULT_BATCH_SIZE): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid --batch-size: ${raw || String(fallback)}`);
  }
  if (value > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size ${value} exceeds maximum ${MAX_BATCH_SIZE}`);
  }
  return value;
}
