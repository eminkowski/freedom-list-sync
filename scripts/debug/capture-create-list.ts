/**
 * One-shot: open an authenticated Freedom session, create one empty custom
 * blocklist via the UI (or best-effort API probes if UI selectors fail), and
 * print every mutating freedom.to exchange for createFilterList wiring.
 *
 * Usage:
 *   npx tsx scripts/capture-create-list.ts
 *   npx tsx scripts/capture-create-list.ts --name "FLS Create Probe"
 */
import { FREEDOM_HOME_URL, FREEDOM_ORIGIN, getAuthStatePath } from "../../src/freedom/auth.js";
import { closeFreedomContext, openFreedomContext } from "../../src/freedom/client.js";
import { readCsrfToken } from "../../src/freedom/csrf.js";
import { createLogger } from "../../src/utils/logger.js";

const SENSITIVE_KEYS = [
  "password",
  "token",
  "csrf",
  "authenticity_token",
  "authorization",
  "session",
  "secret",
  "api_key",
  "access_token",
];

interface Captured {
  method: string;
  url: string;
  requestBody?: string;
  status?: number;
  responseBody?: string;
}

function parseName(): string {
  const idx = process.argv.indexOf("--name");
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1]!;
  }
  return `FLS Create Probe ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.some((part) => key.toLowerCase().includes(part))
      ? "[REDACTED]"
      : redact(nested);
  }
  return out;
}

function sanitizeBody(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.stringify(redact(JSON.parse(trimmed)), null, 2);
  } catch {
    return trimmed.slice(0, 4000);
  }
}

async function main(): Promise<void> {
  const logger = createLogger();
  const listName = parseName();
  const captures: Captured[] = [];

  logger.info(`Auth: ${getAuthStatePath()}`);
  logger.info(`Will create (or attempt): ${JSON.stringify(listName)}`);
  logger.info("");

  const context = await openFreedomContext({ headed: true });
  const page = context.pages()[0] ?? (await context.newPage());

  page.on("request", (request) => {
    const method = request.method().toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== FREEDOM_ORIGIN) {
      return;
    }
    captures.push({
      method,
      url: `${url.origin}${url.pathname}${url.search}`,
      ...(request.postData() ? { requestBody: sanitizeBody(request.postData() ?? undefined) } : {}),
    });
    logger.info(`[req] ${method} ${url.pathname}${url.search}`);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const method = request.method().toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== FREEDOM_ORIGIN) {
      return;
    }
    const entry =
      [...captures]
        .reverse()
        .find(
          (c) => c.method === method && c.url.includes(url.pathname) && c.status === undefined,
        ) ?? captures[captures.length - 1];
    if (!entry) {
      return;
    }
    entry.status = response.status();
    try {
      const text = await response.text();
      entry.responseBody = sanitizeBody(text);
    } catch {
      // ignore
    }
    logger.info(`[res] ${method} ${url.pathname} -> ${response.status()}`);
  });

  await page.goto(FREEDOM_HOME_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Best-effort UI path: look for create / new blocklist controls.
  const uiCreated = await tryCreateViaUi(page, listName, logger);

  if (!uiCreated) {
    logger.warn("UI create path unclear; probing likely POST /filter_lists/ shapes…");
    await tryCreateViaApi(context, listName, logger);
  }

  await page.waitForTimeout(1500);

  logger.info("");
  logger.info("=".repeat(72));
  logger.info(`Captured mutating exchanges: ${captures.length}`);
  for (const [index, exchange] of captures.entries()) {
    logger.info("");
    logger.info(`#${index + 1} ${exchange.method} ${exchange.url}`);
    logger.info(`Status: ${exchange.status ?? "(pending)"}`);
    if (exchange.requestBody) {
      logger.info("Request:");
      logger.info(exchange.requestBody);
    }
    if (exchange.responseBody) {
      logger.info("Response:");
      logger.info(exchange.responseBody.slice(0, 3000));
    }
  }

  const createCandidates = captures.filter(
    (c) =>
      c.method === "POST" &&
      /filter_list/i.test(c.url) &&
      c.status !== undefined &&
      c.status >= 200 &&
      c.status < 300,
  );
  logger.info("");
  if (createCandidates.length > 0) {
    logger.info(`Likely create success candidate(s): ${createCandidates.length}`);
  } else {
    logger.info("No clear successful POST filter_lists candidate yet.");
    logger.info(
      "If the browser is open, create the list manually, wait 2s, then Ctrl+C after logs.",
    );
  }

  await closeFreedomContext(context);
}

async function tryCreateViaUi(
  page: import("playwright").Page,
  listName: string,
  logger: ReturnType<typeof createLogger>,
): Promise<boolean> {
  const clickCandidates = [
    'button:has-text("New Blocklist")',
    'button:has-text("Create Blocklist")',
    'a:has-text("New Blocklist")',
    'a:has-text("Create Blocklist")',
    'button:has-text("Add Blocklist")',
    'a:has-text("Add Blocklist")',
    'button:has-text("New List")',
    "text=Create a Blocklist",
    "text=New custom blocklist",
  ];

  for (const selector of clickCandidates) {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) {
      continue;
    }
    try {
      await loc.click({ timeout: 2000 });
      logger.info(`Clicked: ${selector}`);
      await page.waitForTimeout(800);

      const nameInput = page
        .locator(
          'input[name*="name" i], input[placeholder*="name" i], input[aria-label*="name" i], input[type="text"]',
        )
        .first();
      if ((await nameInput.count()) > 0) {
        await nameInput.fill(listName);
        logger.info(`Filled name: ${listName}`);
      }

      const save = page
        .locator(
          'button:has-text("Create"), button:has-text("Save"), button:has-text("Add"), button[type="submit"]',
        )
        .first();
      if ((await save.count()) > 0) {
        await save.click({ timeout: 2000 });
        logger.info("Clicked save/create");
        await page.waitForTimeout(2500);
        return true;
      }
    } catch (error) {
      logger.warn(
        `UI attempt failed for ${selector}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Navigate common blocklist paths.
  for (const path of ["/filter_lists", "/blocklists", "/filters", "/dashboard"]) {
    try {
      await page.goto(`${FREEDOM_ORIGIN}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      await page.waitForTimeout(1000);
      for (const selector of clickCandidates) {
        const loc = page.locator(selector).first();
        if ((await loc.count()) === 0) {
          continue;
        }
        await loc.click({ timeout: 2000 });
        logger.info(`Clicked on ${path}: ${selector}`);
        const nameInput = page.locator('input[type="text"], input[name*="name" i]').first();
        if ((await nameInput.count()) > 0) {
          await nameInput.fill(listName);
          const save = page
            .locator('button:has-text("Create"), button:has-text("Save"), button[type="submit"]')
            .first();
          if ((await save.count()) > 0) {
            await save.click();
            await page.waitForTimeout(2500);
            return true;
          }
        }
      }
    } catch {
      // try next path
    }
  }

  return false;
}

async function tryCreateViaApi(
  context: import("playwright").BrowserContext,
  listName: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const csrf = await readCsrfToken(context);
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin: FREEDOM_ORIGIN,
    referer: `${FREEDOM_ORIGIN}/`,
    "x-csrf-token": csrf,
    "x-requested-with": "XMLHttpRequest",
  };

  const payloads: Array<{ label: string; url: string; body: unknown }> = [
    {
      label: "POST /filter_lists/ {name}",
      url: `${FREEDOM_ORIGIN}/filter_lists/`,
      body: { name: listName },
    },
    {
      label: "POST /filter_lists/ {filter_list.name}",
      url: `${FREEDOM_ORIGIN}/filter_lists/`,
      body: { filter_list: { name: listName } },
    },
    {
      label: "POST /filter_lists.json {name}",
      url: `${FREEDOM_ORIGIN}/filter_lists.json`,
      body: { name: listName },
    },
    {
      label: "POST /filter_lists {filter_list: {name, custom_filters: []}}",
      url: `${FREEDOM_ORIGIN}/filter_lists/`,
      body: { filter_list: { name: listName, custom_filters: [] } },
    },
  ];

  for (const attempt of payloads) {
    logger.info(`API probe: ${attempt.label}`);
    const response = await context.request.post(attempt.url, {
      data: attempt.body,
      headers,
      failOnStatusCode: false,
      timeout: 30_000,
    });
    const text = await response.text();
    logger.info(`  -> HTTP ${response.status()} body=${text.slice(0, 500).replace(/\s+/g, " ")}`);
    if (response.ok()) {
      logger.info("  SUCCESS — use this shape for createFilterList");
      return;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
