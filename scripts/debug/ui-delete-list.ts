/**
 * Headed UI helper: open Freedom and try to delete a named blocklist via the UI.
 * Does not guess numeric IDs from HTML.
 *
 *   npx tsx scripts/debug/ui-delete-list.ts --name "My Blocklist"
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { FREEDOM_HOME_URL, FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import { closeFreedomContext, openFreedomContext } from "../../src/freedom/client.js";
import { createLogger } from "../../src/utils/logger.js";

function parseName(): string {
  const idx = process.argv.indexOf("--name");
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1]!;
  }
  return "My Blocklist";
}

async function main(): Promise<void> {
  const logger = createLogger();
  const listName = parseName();
  const auto = process.argv.includes("--auto");

  logger.info(`Opening Freedom to delete blocklist: ${JSON.stringify(listName)}`);
  logger.info("This uses the UI only — no inferred list IDs.");
  logger.info("");

  const context = await openFreedomContext({ headed: true });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(FREEDOM_HOME_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Try common list/filter navigation.
    for (const path of ["/", "/filter_lists", "/blocklists", "/filters"]) {
      try {
        await page.goto(`${FREEDOM_ORIGIN}${path}`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        await page.waitForTimeout(1000);
        const hit = page.getByText(listName, { exact: true }).first();
        if ((await hit.count()) > 0) {
          logger.info(`Found visible text for ${JSON.stringify(listName)} on ${path}`);
          await hit.click({ timeout: 3000 }).catch(() => undefined);
          await page.waitForTimeout(1000);
          break;
        }
      } catch {
        // continue
      }
    }

    // Look for a delete control near the list name / on the open detail page.
    const deleteCandidates = [
      `button:has-text("Delete")`,
      `a:has-text("Delete")`,
      `button:has-text("Remove")`,
      `button[aria-label*="Delete" i]`,
      `button:has-text("Delete Blocklist")`,
      `button:has-text("Delete List")`,
    ];

    let clickedDelete = false;
    for (const selector of deleteCandidates) {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) {
        continue;
      }
      try {
        await loc.click({ timeout: 2000 });
        clickedDelete = true;
        logger.info(`Clicked: ${selector}`);
        await page.waitForTimeout(800);
        // Confirm dialogs.
        const confirm = page
          .locator(
            'button:has-text("Delete"), button:has-text("Confirm"), button:has-text("Yes"), button:has-text("OK")',
          )
          .last();
        if ((await confirm.count()) > 0) {
          await confirm.click({ timeout: 2000 }).catch(() => undefined);
          logger.info("Clicked confirm");
        }
        break;
      } catch (error) {
        logger.warn(
          `Delete click failed for ${selector}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!clickedDelete) {
      logger.warn("Could not auto-click a Delete control.");
      logger.info("Please delete the oversized list manually in the open browser.");
    }

    if (!auto) {
      const rl = createInterface({ input, output });
      try {
        await rl.question(
          "Press Enter here after the oversized list is deleted (or if you need me to stop)…\n",
        );
      } finally {
        rl.close();
      }
    } else {
      await page.waitForTimeout(3000);
    }

    // Quick collection health check.
    const res = await context.request.get(`${FREEDOM_ORIGIN}/filter_lists/`, {
      failOnStatusCode: false,
      timeout: 60_000,
    });
    const body = await res.text();
    logger.info("");
    logger.info(`GET /filter_lists/ -> ${res.status()} (${body.length} chars)`);
    if (res.ok()) {
      logger.info("Collection read recovered.");
    } else {
      logger.warn("Collection read still unhealthy.");
    }
  } finally {
    await closeFreedomContext(context);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
