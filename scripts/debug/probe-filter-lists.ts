/**
 * One-off helper used during Phase 4 verification.
 * Dumps a sanitized summary of the Freedom filter_lists response shape.
 */
import { writeFile } from "node:fs/promises";

import { FREEDOM_FILTER_LISTS_URL } from "../../src/freedom/auth.js";
import { openFreedomContext } from "../../src/freedom/client.js";

async function main(): Promise<void> {
  const context = await openFreedomContext({ headed: false });
  try {
    const response = await context.request.get(FREEDOM_FILTER_LISTS_URL, {
      failOnStatusCode: false,
    });
    const status = response.status();
    const contentType = response.headers()["content-type"] ?? "";
    const text = await response.text();

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const summary = summarize(parsed);
    const report = {
      status,
      contentType,
      topLevelKeys:
        parsed && typeof parsed === "object" ? Object.keys(parsed as object) : [],
      summary,
      rawPreview: text.slice(0, 1500),
    };

    await writeFile(
      ".freedom-list-sync/filter-lists-probe.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
}

function summarize(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") {
    return { kind: typeof parsed };
  }

  const root = parsed as Record<string, unknown>;
  const lists = Array.isArray(root.filter_lists) ? root.filter_lists : [];

  return {
    filterListCount: lists.length,
    lists: lists.slice(0, 20).map((item) => {
      if (!item || typeof item !== "object") {
        return { invalid: true };
      }
      const record = item as Record<string, unknown>;
      const filters = Array.isArray(record.custom_filters)
        ? record.custom_filters
        : Array.isArray(record.customFilters)
          ? record.customFilters
          : [];
      const sampleFilter =
        filters[0] && typeof filters[0] === "object"
          ? Object.keys(filters[0] as object)
          : [];
      return {
        keys: Object.keys(record),
        id: record.id,
        name: record.name,
        count_websites: record.count_websites ?? record.countWebsites,
        customFilterCount: filters.length,
        sampleFilterKeys: sampleFilter,
      };
    }),
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
