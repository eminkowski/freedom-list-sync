/**
 * Scrape Freedom HTML/JS for filter_list ids when GET /filter_lists/ is unhealthy.
 */
import { FREEDOM_HOME_URL, FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import { closeFreedomContext, openFreedomContext } from "../../src/freedom/client.js";
import { readCsrfToken } from "../../src/freedom/csrf.js";
import { buildAddDomainsHeaders } from "../../src/freedom/http-writer.js";

async function main(): Promise<void> {
  const shouldDelete = process.argv.includes("--delete-all-custom");
  const deleteNames = new Set(
    process.argv.includes("--delete-name")
      ? [process.argv[process.argv.indexOf("--delete-name") + 1]!].filter(Boolean)
      : [],
  );

  const context = await openFreedomContext({ headed: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(FREEDOM_HOME_URL, { waitUntil: "networkidle" }).catch(async () => {
      await page.goto(FREEDOM_HOME_URL, { waitUntil: "domcontentloaded" });
    });
    await page.waitForTimeout(2000);

    const html = await page.content();
    const idMatches = [...html.matchAll(/filter_lists?\/(\d+)/gi)].map((m) => Number(m[1]));
    const nameIdPairs: Array<{ id: number; name?: string }> = [];

    // Look for JSON blobs embedded in the page.
    const scriptJsons = [...html.matchAll(/\{[^{}]*"filter_lists"\s*:\s*\[[\s\S]*?\]\s*[,}]/g)];
    for (const match of scriptJsons.slice(0, 5)) {
      console.log(`Embedded filter_lists-looking blob length=${match[0].length}`);
    }

    // Broader: any {"id":N,"name":"..."} near filter context
    for (const match of html.matchAll(/"id"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"/g)) {
      const id = Number(match[1]);
      const name = match[2]!;
      if (id > 1000) {
        nameIdPairs.push({ id, name });
      }
    }

    const uniqueIds = [...new Set(idMatches.filter((n) => Number.isFinite(n) && n > 0))];
    console.log(`IDs from URLs in HTML: ${uniqueIds.join(", ") || "(none)"}`);
    console.log(`id/name pairs found: ${nameIdPairs.length}`);
    const seen = new Set<string>();
    for (const pair of nameIdPairs) {
      const key = `${pair.id}:${pair.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ${pair.id}\t${pair.name}`);
    }

    // Also dump any window.__INITIAL or similar
    const initial = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const keys = Object.keys(w).filter((k) => /initial|preload|state|freedom|filter/i.test(k));
      return keys.slice(0, 40);
    });
    console.log(`Interesting window keys: ${initial.join(", ") || "(none)"}`);

    if (shouldDelete || deleteNames.size > 0) {
      const csrf = await readCsrfToken(context);
      const targets = nameIdPairs.filter((p) =>
        shouldDelete ? true : p.name !== undefined && deleteNames.has(p.name),
      );
      // Prefer unique by id
      const byId = new Map(targets.map((t) => [t.id, t]));
      for (const target of byId.values()) {
        const res = await context.request.delete(`${FREEDOM_ORIGIN}/filter_lists/${target.id}`, {
          headers: buildAddDomainsHeaders(csrf),
          failOnStatusCode: false,
          timeout: 60_000,
        });
        console.log(
          `DELETE ${target.id} (${target.name ?? "?"}) -> ${res.status()} ${(await res.text()).slice(0, 120)}`,
        );
      }
    }
  } finally {
    await closeFreedomContext(context);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
