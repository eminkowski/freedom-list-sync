import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTH_FILE_VERSION,
  FreedomAuthFileInvalidError,
  formatAuthStatusReport,
  getAuthStatePath,
  getConfigDir,
  loadAuthFile,
  saveAuthStateFile,
} from "../src/freedom/auth.js";

const previousHome = process.env.FREEDOM_LIST_SYNC_HOME;

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.FREEDOM_LIST_SYNC_HOME;
  } else {
    process.env.FREEDOM_LIST_SYNC_HOME = previousHome;
  }
});

describe("auth helpers", () => {
  it("formats status reports for each state", () => {
    expect(formatAuthStatusReport("authenticated")).toContain("Session valid");
    expect(formatAuthStatusReport("authenticated", { listsHealthy: false })).toContain(
      "GET /filter_lists/ is currently failing",
    );
    expect(formatAuthStatusReport("expired")).toContain("freedom-list-sync login");
    expect(formatAuthStatusReport("missing")).toContain("no session");
    expect(formatAuthStatusReport("unavailable")).toContain(
      "Freedom unavailable; authentication could not be verified",
    );
    expect(formatAuthStatusReport("unavailable")).not.toContain("freedom-list-sync login");
    expect(formatAuthStatusReport("invalid")).toContain(
      "Session file is invalid; run freedom-list-sync login --force.",
    );
  });

  it("places auth state under the user config dir", () => {
    expect(getAuthStatePath().startsWith(getConfigDir())).toBe(true);
    expect(getAuthStatePath().endsWith("auth.json")).toBe(true);
    expect(AUTH_FILE_VERSION).toBe(1);
  });

  it("writes versioned metadata and round-trips storageState", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fls-auth-"));
    process.env.FREEDOM_LIST_SYNC_HOME = dir;
    await mkdir(dir, { recursive: true });

    const storageState = { cookies: [], origins: [] };
    await saveAuthStateFile(storageState, { accountEmail: "user@example.com" });

    const file = await loadAuthFile();
    expect(file.version).toBe(1);
    expect(file.storageState).toEqual(storageState);
    expect(file.accountEmail).toBe("user@example.com");
    expect(file.createdAt).toMatch(/^\d{4}-/);
    expect(file.lastValidatedAt).toMatch(/^\d{4}-/);

    const raw = JSON.parse(await readFile(getAuthStatePath(), "utf8")) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(raw.createdAt).toBeTruthy();
    expect(raw.lastValidatedAt).toBeTruthy();
    expect(raw.savedAt).toBeUndefined();
  });

  it("rejects corrupt auth.json with a clean recovery message", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fls-auth-"));
    process.env.FREEDOM_LIST_SYNC_HOME = dir;
    await mkdir(dir, { recursive: true });
    await writeFile(getAuthStatePath(), "{not-json", "utf8");

    await expect(loadAuthFile()).rejects.toBeInstanceOf(FreedomAuthFileInvalidError);
    await expect(loadAuthFile()).rejects.toThrow(
      /Session file is invalid; run freedom-list-sync login --force/,
    );
  });
});
