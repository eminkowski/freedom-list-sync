/**
 * Diagnose filter_lists health and optionally DELETE a list by id.
 *
 *   npx tsx scripts/probe-lists-health.ts
 *   npx tsx scripts/probe-lists-health.ts --delete 6633996
 */
import { FREEDOM_FILTER_LISTS_URL, FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import { closeFreedomContext, openFreedomContext } from "../../src/freedom/client.js";
import { readCsrfToken } from "../../src/freedom/csrf.js";
import { buildAddDomainsHeaders } from "../../src/freedom/http-writer.js";

async function main(): Promise<void> {
  const deleteIdx = process.argv.indexOf("--delete");
  const deleteId =
    deleteIdx >= 0 && process.argv[deleteIdx + 1]
      ? Number(process.argv[deleteIdx + 1])
      : undefined;

  const context = await openFreedomContext({ headed: false });
  try {
    const getAll = await context.request.get(FREEDOM_FILTER_LISTS_URL, {
      failOnStatusCode: false,
      timeout: 60_000,
    });
    const allText = await getAll.text();
    console.log(`GET /filter_lists/ -> ${getAll.status()} (${allText.length} chars)`);
    if (getAll.ok()) {
      try {
        const parsed = JSON.parse(allText) as { filter_lists?: Array<{ id: number; name: string; count_websites?: number }> };
        for (const list of parsed.filter_lists ?? []) {
          console.log(
            `  ${list.id}\t${list.count_websites ?? "?"}\t${list.name}`,
          );
        }
      } catch {
        console.log(allText.slice(0, 500));
      }
    } else {
      console.log(`  body preview: ${allText.slice(0, 300)}`);
    }

    // Probe single-list GET for the create probe id if collection failed.
    for (const id of [6633996, deleteId].filter((v): v is number => Number.isFinite(v))) {
      const one = await context.request.get(`${FREEDOM_ORIGIN}/filter_lists/${id}`, {
        failOnStatusCode: false,
        timeout: 30_000,
      });
      const text = await one.text();
      console.log(`GET /filter_lists/${id} -> ${one.status()} (${text.slice(0, 200).replace(/\s+/g, " ")})`);
    }

    if (deleteId !== undefined && Number.isFinite(deleteId)) {
      const csrf = await readCsrfToken(context);
      const del = await context.request.delete(`${FREEDOM_ORIGIN}/filter_lists/${deleteId}`, {
        headers: buildAddDomainsHeaders(csrf),
        failOnStatusCode: false,
        timeout: 30_000,
      });
      console.log(`DELETE /filter_lists/${deleteId} -> ${del.status()} ${(await del.text()).slice(0, 200)}`);
    }
  } finally {
    await closeFreedomContext(context);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
