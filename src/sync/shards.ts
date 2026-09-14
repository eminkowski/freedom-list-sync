import type { FreedomFilterList } from "../freedom/types.js";
import { listDomains } from "../freedom/reader.js";
import { diffDomains, type DomainDiff } from "./diff.js";

/** Conservative operational default — not an official Freedom limit. */
export const DEFAULT_SHARD_SIZE = 2500;
export const MIN_SHARD_SIZE = 100;
export const MAX_SHARD_SIZE = 5000;

export interface LogicalFreedomTarget {
  baseName: string;
  shardSize: number;
  shards: FreedomFilterList[];
}

export interface ShardCapacity {
  current: number;
  maximum: number;
  remaining: number;
  oversized: boolean;
}

export interface ShardWriteAllocation {
  /** Display / create name for this shard. */
  name: string;
  /** Present when the shard already exists in Freedom. */
  list?: FreedomFilterList;
  domains: string[];
  isNew: boolean;
  /** Current count before this plan's writes (0 for new shards). */
  currentCount: number;
  maximum: number;
}

export interface ShardedSyncPlan {
  baseName: string;
  shardSize: number;
  mode: "additive" | "mirror";
  dryRun: boolean;
  sourceUrl: string;
  sourceHash: string;
  sourceDomainCount: number;
  target: LogicalFreedomTarget;
  existingManagedDomains: Set<string>;
  diff: DomainDiff;
  domainsToAdd: string[];
  allocations: ShardWriteAllocation[];
  newShardNames: string[];
  oversizedShards: FreedomFilterList[];
}

export class AdditionalShardsRequiredError extends Error {
  readonly shardNames: string[];

  constructor(shardNames: string[]) {
    const unique = [...new Set(shardNames)];
    const lines =
      unique.length === 1
        ? [
            "Additional shard required:",
            "",
            `  ${unique[0]}`,
            "",
            "Create this blocklist in Freedom and rerun the command.",
          ]
        : [
            "Additional shards required:",
            "",
            ...unique.map((name) => `  ${name}`),
            "",
            "Create these blocklists in Freedom and rerun the command.",
          ];
    super(lines.join("\n"));
    this.name = "AdditionalShardsRequiredError";
    this.shardNames = unique;
  }
}

export class ShardSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShardSizeError";
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Exact managed-shard matcher for a logical base name.
 * Matches `Base` and `Base N` for integer N >= 2 — not `Base Backup` / `Base 1`.
 *
 * Prefer {@link parseShardIndex} for acceptance checks; this regex is a close
 * approximation (it also matches the unused `Base 1` form, which parseShardIndex rejects).
 */
export function managedShardPattern(baseName: string): RegExp {
  return new RegExp(`^${escapeRegExp(baseName)}(?: ([1-9]\\d*))?$`);
}

/** Shard index: base list = 1, `Base 2` = 2, etc. `Base 1` is not managed. */
export function parseShardIndex(baseName: string, listName: string): number | null {
  if (listName === baseName) {
    return 1;
  }

  const match = new RegExp(`^${escapeRegExp(baseName)} ([1-9]\\d*)$`).exec(listName);
  if (!match) {
    return null;
  }

  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 2) {
    return null;
  }
  return index;
}

export function shardName(baseName: string, index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid shard index: ${index}`);
  }
  return index === 1 ? baseName : `${baseName} ${index}`;
}

export function discoverManagedShards(
  lists: readonly FreedomFilterList[],
  baseName: string,
): FreedomFilterList[] {
  return lists
    .filter((list) => parseShardIndex(baseName, list.name) !== null)
    .sort((a, b) => {
      const ai = parseShardIndex(baseName, a.name) ?? Number.MAX_SAFE_INTEGER;
      const bi = parseShardIndex(baseName, b.name) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) {
        return ai - bi;
      }
      return a.id - b.id;
    });
}

/**
 * Resolve `--list` into a logical base name.
 * Numeric IDs use the matched list's exact name as the base.
 */
export function resolveLogicalBaseName(
  lists: readonly FreedomFilterList[],
  selector: string,
): string {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Logical list name must not be empty.");
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    const match = lists.find((list) => list.id === id);
    if (!match) {
      throw new Error(`No Freedom blocklist matched id ${trimmed}.`);
    }
    return match.name;
  }

  return trimmed;
}

export function buildLogicalTarget(
  lists: readonly FreedomFilterList[],
  baseName: string,
  shardSize: number,
): LogicalFreedomTarget {
  return {
    baseName,
    shardSize,
    shards: discoverManagedShards(lists, baseName),
  };
}

export function parseShardSize(
  raw: string | undefined,
  options: { allowUnsafe?: boolean } = {},
): number {
  const allowUnsafe = options.allowUnsafe === true;
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_SHARD_SIZE : Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new ShardSizeError(`Invalid --shard-size: ${raw ?? String(DEFAULT_SHARD_SIZE)}`);
  }

  if (!allowUnsafe && value < MIN_SHARD_SIZE) {
    throw new ShardSizeError(
      `--shard-size ${value} is below the safe minimum (${MIN_SHARD_SIZE}). ` +
        `Pass --allow-unsafe-shard-size to override.`,
    );
  }

  if (!allowUnsafe && value > MAX_SHARD_SIZE) {
    throw new ShardSizeError(
      `--shard-size ${value} exceeds the safe maximum (${MAX_SHARD_SIZE}). ` +
        `Pass --allow-unsafe-shard-size to override.`,
    );
  }

  return value;
}

export function shardDomainCount(list: FreedomFilterList): number {
  return listDomains(list).length;
}

export function computeShardCapacity(currentCount: number, shardSize: number): ShardCapacity {
  const oversized = currentCount > shardSize;
  const remaining = oversized ? 0 : Math.max(0, shardSize - currentCount);
  return {
    current: currentCount,
    maximum: shardSize,
    remaining,
    oversized,
  };
}

export function unionManagedDomains(shards: readonly FreedomFilterList[]): Set<string> {
  const union = new Set<string>();
  for (const shard of shards) {
    for (const domain of listDomains(shard)) {
      union.add(domain);
    }
  }
  return union;
}

/**
 * Lexicographic fixed-size chunking for documentation / future mirror stability.
 * Additive sync does not move domains to match these chunks.
 */
export function theoreticalSourceChunks(
  sourceDomains: readonly string[],
  shardSize: number,
): string[][] {
  if (shardSize <= 0) {
    throw new Error(`shardSize must be positive, got ${shardSize}`);
  }
  const sorted = [...new Set(sourceDomains)].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < sorted.length; i += shardSize) {
    chunks.push(sorted.slice(i, i + shardSize));
  }
  return chunks;
}

/**
 * Next shard display names, filling numeric gaps before extending past the max index.
 * Skips names already taken by any Freedom list (exact match).
 */
export function nextShardNames(
  baseName: string,
  existingManaged: readonly FreedomFilterList[],
  allLists: readonly FreedomFilterList[],
  count: number,
): string[] {
  if (count <= 0) {
    return [];
  }

  const usedIndexes = new Set<number>();
  for (const shard of existingManaged) {
    const index = parseShardIndex(baseName, shard.name);
    if (index !== null) {
      usedIndexes.add(index);
    }
  }

  const takenNames = new Set(allLists.map((list) => list.name));
  const names: string[] = [];
  let candidate = 1;

  while (names.length < count) {
    if (!usedIndexes.has(candidate)) {
      const name = shardName(baseName, candidate);
      if (!takenNames.has(name)) {
        names.push(name);
        usedIndexes.add(candidate);
        takenNames.add(name);
      }
    }
    candidate += 1;
    if (candidate > 1_000_000) {
      throw new Error("Unable to allocate shard names.");
    }
  }

  return names;
}

/**
 * Allocate missing domains into live shard capacity, then plan new shards.
 * Domains are taken in sorted order for deterministic planning.
 * Does not move or remove existing domains; oversized shards receive nothing.
 */
export function allocateShardWrites(input: {
  baseName: string;
  shardSize: number;
  existingShards: readonly FreedomFilterList[];
  allLists: readonly FreedomFilterList[];
  domainsToAdd: readonly string[];
}): ShardWriteAllocation[] {
  const remaining = [...input.domainsToAdd].sort();
  const allocations: ShardWriteAllocation[] = [];

  for (const shard of input.existingShards) {
    if (remaining.length === 0) {
      break;
    }
    const current = shardDomainCount(shard);
    const capacity = computeShardCapacity(current, input.shardSize);
    if (capacity.remaining === 0) {
      continue;
    }
    const take = remaining.splice(0, capacity.remaining);
    allocations.push({
      name: shard.name,
      list: shard,
      domains: take,
      isNew: false,
      currentCount: current,
      maximum: input.shardSize,
    });
  }

  if (remaining.length === 0) {
    return allocations;
  }

  const newShardCount = Math.ceil(remaining.length / input.shardSize);
  const newNames = nextShardNames(
    input.baseName,
    input.existingShards,
    input.allLists,
    newShardCount,
  );

  for (const name of newNames) {
    if (remaining.length === 0) {
      break;
    }
    const take = remaining.splice(0, input.shardSize);
    allocations.push({
      name,
      domains: take,
      isNew: true,
      currentCount: 0,
      maximum: input.shardSize,
    });
  }

  return allocations;
}

export function buildShardedSyncPlan(input: {
  mode: "additive" | "mirror";
  dryRun: boolean;
  sourceUrl: string;
  sourceHash: string;
  sourceDomains: readonly string[];
  baseName: string;
  shardSize: number;
  allLists: readonly FreedomFilterList[];
}): ShardedSyncPlan {
  const target = buildLogicalTarget(input.allLists, input.baseName, input.shardSize);
  const existingManagedDomains = unionManagedDomains(target.shards);
  const diff = diffDomains(input.sourceDomains, existingManagedDomains);
  const domainsToAdd = [...diff.additions].sort();
  const allocations = allocateShardWrites({
    baseName: input.baseName,
    shardSize: input.shardSize,
    existingShards: target.shards,
    allLists: input.allLists,
    domainsToAdd,
  });

  const newShardNames = allocations.filter((a) => a.isNew).map((a) => a.name);
  const oversizedShards = target.shards.filter(
    (shard) => computeShardCapacity(shardDomainCount(shard), input.shardSize).oversized,
  );

  return {
    baseName: input.baseName,
    shardSize: input.shardSize,
    mode: input.mode,
    dryRun: input.dryRun,
    sourceUrl: input.sourceUrl,
    sourceHash: input.sourceHash,
    sourceDomainCount: input.sourceDomains.length,
    target,
    existingManagedDomains,
    diff,
    domainsToAdd,
    allocations,
    newShardNames,
    oversizedShards,
  };
}

export function formatShardedPlanReport(plan: ShardedSyncPlan): string {
  const lines: string[] = [];
  lines.push(`Logical target: ${plan.baseName}`);
  lines.push(`Shard size:     ${formatNumber(plan.shardSize)}`);
  lines.push("");
  lines.push(`Existing shards:     ${formatNumber(plan.target.shards.length)}`);
  lines.push(`New shards required: ${formatNumber(plan.newShardNames.length)}`);
  lines.push("");

  if (plan.target.shards.length === 0) {
    lines.push("Managed shards: (none yet)");
  } else {
    lines.push("Managed shards:");
    lines.push("");
    for (const shard of plan.target.shards) {
      const capacity = computeShardCapacity(shardDomainCount(shard), plan.shardSize);
      const status = capacity.oversized ? "  OVERSIZED" : "";
      lines.push(
        `${padName(shard.name)}  ${formatNumber(capacity.current)} / ${formatNumber(capacity.maximum)}${status}`,
      );
    }
  }

  lines.push("");
  lines.push(`Source domains:      ${formatNumber(plan.sourceDomainCount)}`);
  lines.push(`Already present:     ${formatNumber(plan.diff.unchangedCount)}`);
  lines.push(`To add:              ${formatNumber(plan.domainsToAdd.length)}`);
  lines.push(`Only in Freedom:     ${formatNumber(plan.diff.removals.length)}`);

  if (plan.allocations.length > 0) {
    lines.push("");
    lines.push("Planned writes:");
    lines.push("");
    for (const allocation of plan.allocations) {
      const tag = allocation.isNew ? "  [new]" : "";
      lines.push(`${padName(allocation.name)}  +${formatNumber(allocation.domains.length)}${tag}`);
    }
  }

  if (plan.newShardNames.length > 0) {
    lines.push("");
    lines.push("Will create:");
    for (const name of plan.newShardNames) {
      lines.push(`  ${name}`);
    }
    lines.push("");
    lines.push("Note: live sync will create these lists automatically via POST /filter_lists/.");
  }

  return lines.join("\n");
}

function padName(name: string, width = 20): string {
  return name.length >= width ? name : name.padEnd(width, " ");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
