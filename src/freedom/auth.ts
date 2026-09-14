import { chmod, mkdir, rm, access, constants, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FREEDOM_ORIGIN = "https://freedom.to";
export const FREEDOM_FILTER_LISTS_URL = `${FREEDOM_ORIGIN}/filter_lists/`;
export const FREEDOM_HOME_URL = `${FREEDOM_ORIGIN}/`;
/** Common Freedom sign-in entry; home also redirects when logged out. */
export const FREEDOM_LOGIN_URL = `${FREEDOM_ORIGIN}/users/sign_in`;

export const PROFILE_DIR_NAME = ".freedom-profile";
export const CONFIG_DIR_NAME = "freedom-list-sync";
export const AUTH_STATE_FILE = "auth.json";
export const AUTH_FILE_VERSION = 1 as const;

export type FreedomAuthStatus =
  | "authenticated"
  | "expired"
  | "unavailable"
  | "missing"
  | "invalid";

export interface FreedomAuthFileMeta {
  createdAt: string;
  lastValidatedAt?: string;
  /** Only stored when Freedom explicitly returns an account email. */
  accountEmail?: string;
}

export interface FreedomAuthFileV1 extends FreedomAuthFileMeta {
  version: typeof AUTH_FILE_VERSION;
  /** Playwright storageState payload (cookies + origins). */
  storageState: unknown;
}

export function getConfigDir(): string {
  if (process.env.FREEDOM_LIST_SYNC_HOME?.trim()) {
    return path.resolve(process.env.FREEDOM_LIST_SYNC_HOME.trim());
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", CONFIG_DIR_NAME);
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, CONFIG_DIR_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".config"), CONFIG_DIR_NAME);
}

export function getAuthStatePath(): string {
  return path.join(getConfigDir(), AUTH_STATE_FILE);
}

/**
 * Legacy project-local Chromium profile.
 * Temporary compatibility for older installs; may be removed in a future major version.
 */
export function getProfileDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, PROFILE_DIR_NAME);
}

export async function authStateExists(): Promise<boolean> {
  try {
    await access(getAuthStatePath(), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function legacyProfileExists(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await access(getProfileDir(cwd), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureConfigDir(): Promise<string> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function saveAuthStateFile(
  storageState: unknown,
  options: {
    accountEmail?: string;
    /** Preserve createdAt when refreshing an existing session. */
    createdAt?: string;
  } = {},
): Promise<string> {
  const dir = await ensureConfigDir();
  const target = path.join(dir, AUTH_STATE_FILE);
  const now = new Date().toISOString();
  const existing = await tryReadAuthFileMeta();
  const createdAt = options.createdAt ?? existing?.createdAt ?? now;

  const payload: FreedomAuthFileV1 = {
    version: AUTH_FILE_VERSION,
    createdAt,
    lastValidatedAt: now,
    storageState,
    ...(options.accountEmail
      ? { accountEmail: options.accountEmail }
      : existing?.accountEmail
        ? { accountEmail: existing.accountEmail }
        : {}),
  };
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(target, 0o600);
  } catch {
    // Best-effort on platforms that ignore chmod.
  }
  return target;
}

/**
 * Update non-secret metadata after a successful lightweight auth probe.
 */
export async function touchAuthValidated(options: { accountEmail?: string } = {}): Promise<void> {
  if (!(await authStateExists())) {
    return;
  }
  const file = await loadAuthFile();
  const now = new Date().toISOString();
  const payload: FreedomAuthFileV1 = {
    version: AUTH_FILE_VERSION,
    createdAt: file.createdAt,
    lastValidatedAt: now,
    storageState: file.storageState,
    ...(options.accountEmail
      ? { accountEmail: options.accountEmail }
      : file.accountEmail
        ? { accountEmail: file.accountEmail }
        : {}),
  };
  await writeFile(getAuthStatePath(), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(getAuthStatePath(), 0o600);
  } catch {
    // Best-effort on platforms that ignore chmod.
  }
}

/**
 * Load the versioned auth file (metadata + storageState).
 * Accepts legacy raw Playwright storageState files for one release.
 */
export async function loadAuthFile(): Promise<FreedomAuthFileV1> {
  const authPath = getAuthStatePath();
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    throw new FreedomAuthFileInvalidError(authPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FreedomAuthFileInvalidError(authPath);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new FreedomAuthFileInvalidError(authPath);
  }

  const record = parsed as Record<string, unknown>;

  // Versioned format.
  if ("version" in record && "storageState" in record) {
    if (record.version !== AUTH_FILE_VERSION) {
      throw new FreedomAuthFileInvalidError(authPath);
    }
    if (record.storageState === undefined) {
      throw new FreedomAuthFileInvalidError(authPath);
    }
    const createdAt =
      asIsoString(record.createdAt) ??
      asIsoString(record.savedAt) ??
      new Date(0).toISOString();
    const lastValidatedAt = asIsoString(record.lastValidatedAt);
    const accountEmail =
      typeof record.accountEmail === "string" && record.accountEmail.includes("@")
        ? record.accountEmail
        : undefined;
    return {
      version: AUTH_FILE_VERSION,
      createdAt,
      storageState: record.storageState,
      ...(lastValidatedAt ? { lastValidatedAt } : {}),
      ...(accountEmail ? { accountEmail } : {}),
    };
  }

  // Legacy raw Playwright storageState ({ cookies, origins }).
  if (Array.isArray(record.cookies)) {
    return {
      version: AUTH_FILE_VERSION,
      createdAt: new Date(0).toISOString(),
      storageState: parsed,
    };
  }

  throw new FreedomAuthFileInvalidError(authPath);
}

/**
 * Load Playwright storageState from the versioned auth file.
 */
export async function loadAuthStorageState(): Promise<unknown> {
  const file = await loadAuthFile();
  return file.storageState;
}

async function tryReadAuthFileMeta(): Promise<FreedomAuthFileMeta | undefined> {
  try {
    const file = await loadAuthFile();
    return {
      createdAt: file.createdAt,
      ...(file.lastValidatedAt ? { lastValidatedAt: file.lastValidatedAt } : {}),
      ...(file.accountEmail ? { accountEmail: file.accountEmail } : {}),
    };
  } catch {
    return undefined;
  }
}

function asIsoString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Clears local auth used by this tool only (storage state + legacy profile).
 * Does not call Freedom logout APIs.
 */
export async function clearLocalAuth(
  cwd: string = process.cwd(),
  options: { removeLegacyProfile?: boolean } = {},
): Promise<{
  removedAuthState: boolean;
  removedLegacyProfile: boolean;
}> {
  const removeLegacyProfile = options.removeLegacyProfile !== false;
  let removedAuthState = false;
  let removedLegacyProfile = false;

  if (await authStateExists()) {
    await rm(getAuthStatePath(), { force: true });
    removedAuthState = true;
  }

  if (removeLegacyProfile && (await legacyProfileExists(cwd))) {
    await rm(getProfileDir(cwd), { recursive: true, force: true });
    removedLegacyProfile = true;
  }

  return { removedAuthState, removedLegacyProfile };
}

export function formatAuthStatusReport(
  status: FreedomAuthStatus,
  details?: {
    listsHealthy?: boolean;
    accountEmail?: string;
    createdAt?: string;
    lastValidatedAt?: string;
  },
): string {
  switch (status) {
    case "authenticated": {
      const lines = ["Freedom: authenticated", "Session valid"];
      if (details?.accountEmail) {
        lines.push(`Account: ${details.accountEmail}`);
      }
      if (details?.lastValidatedAt) {
        lines.push(`Last validated: ${details.lastValidatedAt}`);
      } else if (details?.createdAt) {
        lines.push(`Created: ${details.createdAt}`);
      }
      if (details?.listsHealthy === false) {
        lines.push("");
        lines.push(
          "Note: GET /filter_lists/ is currently failing.",
          "You are signed in, but list sync/inspect may be blocked until Freedom recovers",
          "(for example after an oversized blocklist is removed).",
        );
      }
      return lines.join("\n");
    }
    case "expired":
      return [
        "Freedom: expired",
        "Local session is no longer accepted by Freedom.",
        "",
        "Run:",
        "",
        "  freedom-list-sync login",
      ].join("\n");
    case "missing":
      return [
        "Freedom: no session",
        "No local session found.",
        "",
        "Run:",
        "",
        "  freedom-list-sync login",
      ].join("\n");
    case "invalid":
      return [
        "Freedom: invalid session file",
        "Session file is invalid; run freedom-list-sync login --force.",
      ].join("\n");
    case "unavailable":
      return [
        "Freedom: unavailable",
        "Freedom unavailable; authentication could not be verified.",
        "This is not the same as being logged out — try again shortly.",
      ].join("\n");
  }
}

export class FreedomAuthExpiredError extends Error {
  constructor() {
    super(
      [
        "Freedom authentication has expired.",
        "Run:",
        "",
        "  freedom-list-sync login",
      ].join("\n"),
    );
    this.name = "FreedomAuthExpiredError";
  }
}

export class FreedomAuthUnavailableError extends Error {
  constructor() {
    super(
      [
        "Freedom unavailable; authentication could not be verified.",
        "Try again shortly. This is not the same as being logged out.",
      ].join("\n"),
    );
    this.name = "FreedomAuthUnavailableError";
  }
}

export class FreedomAuthFileInvalidError extends Error {
  readonly authPath: string;

  constructor(authPath: string = getAuthStatePath()) {
    super(`Session file is invalid; run freedom-list-sync login --force.\n\n(${authPath})`);
    this.name = "FreedomAuthFileInvalidError";
    this.authPath = authPath;
  }
}

/** Auth errors that CLIs should print and exit 1 on, without a stack dump. */
export function isFreedomSessionCliError(error: unknown): error is Error {
  return (
    error instanceof FreedomAuthExpiredError ||
    error instanceof FreedomAuthUnavailableError ||
    error instanceof FreedomAuthFileInvalidError
  );
}

export class FreedomListNotFoundError extends Error {
  constructor(selector: string) {
    super(`No Freedom blocklist matched ${JSON.stringify(selector)}.`);
    this.name = "FreedomListNotFoundError";
  }
}

export class FreedomListAmbiguousError extends Error {
  constructor(selector: string, matches: string[]) {
    super(
      `Multiple Freedom blocklists matched ${JSON.stringify(selector)}: ${matches.join(", ")}. ` +
        "Use a numeric list ID instead.",
    );
    this.name = "FreedomListAmbiguousError";
  }
}
