import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SyncMode = "additive" | "mirror";

export interface CheckpointState {
  version: 1;
  source: string;
  targetListId: number;
  mode: SyncMode;
  sourceHash: string;
  startedAt: string;
  updatedAt: string;
  lastSuccessfulBatchAt?: string;
  /** Successfully submitted domains for diagnostics/resume aids. */
  completedDomains: string[];
}

const STATE_DIR = ".freedom-list-sync";
const CHECKPOINT_VERSION = 1 as const;

export function getStateDir(cwd: string = process.cwd()): string {
  return path.join(cwd, STATE_DIR);
}

export function checkpointPath(
  targetListId: number,
  sourceHash: string,
  cwd: string = process.cwd(),
): string {
  const shortHash = sourceHash.replace(/^sha256:/, "").slice(0, 12);
  return path.join(getStateDir(cwd), `checkpoint-${targetListId}-${shortHash}.json`);
}

export async function loadCheckpoint(filePath: string): Promise<CheckpointState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as CheckpointState;
    if (parsed.version !== CHECKPOINT_VERSION) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function saveCheckpoint(state: CheckpointState, cwd?: string): Promise<string> {
  const filePath = checkpointPath(state.targetListId, state.sourceHash, cwd);
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return filePath;
}

export function createCheckpoint(input: {
  source: string;
  targetListId: number;
  mode: SyncMode;
  sourceHash: string;
  completedDomains?: string[];
}): CheckpointState {
  const now = new Date().toISOString();
  return {
    version: CHECKPOINT_VERSION,
    source: input.source,
    targetListId: input.targetListId,
    mode: input.mode,
    sourceHash: input.sourceHash,
    startedAt: now,
    updatedAt: now,
    completedDomains: input.completedDomains ?? [],
  };
}

export async function markDomainsComplete(
  state: CheckpointState,
  domains: string[],
  cwd?: string,
): Promise<CheckpointState> {
  const completed = new Set(state.completedDomains);
  for (const domain of domains) {
    completed.add(domain);
  }

  const now = new Date().toISOString();
  const next: CheckpointState = {
    ...state,
    updatedAt: now,
    lastSuccessfulBatchAt: now,
    completedDomains: [...completed].sort(),
  };

  await saveCheckpoint(next, cwd);
  return next;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
