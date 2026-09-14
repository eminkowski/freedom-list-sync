import type { Command } from "commander";

import {
  clearLocalAuth,
  formatAuthStatusReport,
  getAuthStatePath,
  getProfileDir,
  loadAuthFile,
} from "../../freedom/auth.js";
import { probeAuthStatusDetails } from "../../freedom/client.js";
import { createLogger } from "../../utils/logger.js";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Inspect or manage the local Freedom session");

  auth
    .command("status")
    .description("Show whether the local Freedom session is valid")
    .action(async () => {
      const logger = createLogger();
      const details = await probeAuthStatusDetails();
      let meta: { createdAt?: string; lastValidatedAt?: string; accountEmail?: string } = {};
      try {
        const file = await loadAuthFile();
        meta = {
          ...(file.createdAt ? { createdAt: file.createdAt } : {}),
          ...(file.lastValidatedAt ? { lastValidatedAt: file.lastValidatedAt } : {}),
          ...(file.accountEmail ? { accountEmail: file.accountEmail } : {}),
        };
      } catch {
        // Missing/invalid file — status probe already classified it.
      }

      logger.info(
        formatAuthStatusReport(details.status, {
          ...(details.listsHealthy === false ? { listsHealthy: false } : {}),
          ...(details.accountEmail ?? meta.accountEmail
            ? { accountEmail: details.accountEmail ?? meta.accountEmail }
            : {}),
          ...(meta.lastValidatedAt ? { lastValidatedAt: meta.lastValidatedAt } : {}),
          ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
        }),
      );
      logger.info("");
      logger.info(`Session file: ${getAuthStatePath()}`);
      if (details.status !== "authenticated") {
        process.exitCode = 1;
      }
    });
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Clear the local Freedom session used by this tool")
    .option(
      "--keep-legacy-profile",
      "Keep the older project-local .freedom-profile/ directory",
      false,
    )
    .action(async (options: { keepLegacyProfile?: boolean }) => {
      const logger = createLogger();
      const result = await clearLocalAuth(process.cwd(), {
        removeLegacyProfile: options.keepLegacyProfile !== true,
      });
      logger.info("Local Freedom session cleared.");
      logger.info("");
      logger.info(`Removed auth state:     ${result.removedAuthState ? "yes" : "no"}`);
      logger.info(`Removed legacy profile: ${result.removedLegacyProfile ? "yes" : "no"}`);
      logger.info("");
      logger.info(`Auth state path: ${getAuthStatePath()}`);
      logger.info(`Legacy profile:  ${getProfileDir()}`);
    });
}
