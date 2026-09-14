import type { Command } from "commander";

import { FREEDOM_LOGIN_URL, getAuthStatePath, saveAuthStateFile } from "../../freedom/auth.js";
import { closeFreedomContext, openFreedomContext, probeAuthStatus } from "../../freedom/client.js";
import { probeFreedomSession } from "../../freedom/session-probe.js";
import { createLogger } from "../../utils/logger.js";

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in to Freedom in a browser and save a local session")
    .option("--timeout-minutes <minutes>", "Give up after this many minutes", "30")
    .option("--force", "Open the browser even if a session already looks valid", false)
    .action(async (options: { timeoutMinutes: string; force?: boolean }) => {
      const logger = createLogger();
      const timeoutMinutes = Number(options.timeoutMinutes);
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
        throw new Error(`Invalid --timeout-minutes: ${options.timeoutMinutes}`);
      }

      if (options.force !== true) {
        const status = await probeAuthStatus();
        if (status === "authenticated") {
          logger.info("Freedom: authenticated");
          logger.info("Session valid");
          logger.info("");
          logger.info(`Session file: ${getAuthStatePath()}`);
          logger.info("");
          logger.info("Use --force to sign in again anyway.");
          return;
        }
        if (status === "unavailable") {
          logger.warn(
            "Freedom unavailable; authentication could not be verified. Opening browser login anyway.",
          );
          logger.info("");
        }
      }

      logger.info("Opening Freedom login...");
      logger.info("");
      logger.info("Complete sign-in in the browser.");
      logger.info("(Including MFA if Freedom prompts for it.)");
      logger.info("");

      const context = await openFreedomContext({ headed: true, ephemeral: true });
      const page = context.pages()[0] ?? (await context.newPage());

      try {
        await page.goto(FREEDOM_LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(async () => {
          await page.goto("https://freedom.to/", { waitUntil: "domcontentloaded" });
        });

        const deadline = Date.now() + timeoutMinutes * 60_000;
        while (Date.now() < deadline) {
          try {
            const session = await probeFreedomSession(context);
            if (session.status === "expired") {
              await sleep(2000);
              continue;
            }
            if (session.status === "unavailable") {
              // Partial degradation: keep waiting for a positive lightweight auth signal.
              logger.warn("Freedom partially unavailable; waiting for auth signal…");
              await sleep(2000);
              continue;
            }

            // Authenticated — save even if /filter_lists/ would be unhealthy.
            const state = await context.storageState();
            const savedPath = await saveAuthStateFile(state, {
              ...(session.accountEmail ? { accountEmail: session.accountEmail } : {}),
            });

            logger.info("");
            logger.info("✓ Authentication detected");
            logger.info("✓ Session saved");
            logger.info("");
            logger.info(`Session file: ${savedPath}`);
            logger.info("");
            logger.info("You can close this window.");
            return;
          } catch (error) {
            logger.warn(
              `Waiting for auth… (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
            );
          }
          await sleep(2000);
        }

        logger.error(`Timed out after ${timeoutMinutes} minute(s) waiting for authentication.`);
        process.exitCode = 1;
      } finally {
        await closeFreedomContext(context);
      }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
