/**
 * Remove specific domains from a Freedom list.
 * Observed: PATCH /filter_lists/{id} with `{ custom_domains_to_remove: [...] }`.
 *
 *   npx tsx scripts/debug/remove-domains-from-list.ts --list "My List" --domains example.com,cdn.example.com
 */
import { FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import {
  closeFreedomContext,
  fetchFilterLists,
  openFreedomContext,
} from "../../src/freedom/client.js";
import { readCsrfToken } from "../../src/freedom/csrf.js";
import { buildAddDomainsHeaders } from "../../src/freedom/http-writer.js";
import { createLogger } from "../../src/utils/logger.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const listName = argValue("--list");
  const domainsArg = argValue("--domains");
  if (!listName || !domainsArg) {
    throw new Error(
      'Usage: npx tsx scripts/debug/remove-domains-from-list.ts --list "My List" --domains a.com,b.com',
    );
  }
  const toRemove = new Set(
    domainsArg
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
  if (toRemove.size === 0) {
    throw new Error("No domains provided to --domains.");
  }

  const context = await openFreedomContext({ headed: false });
  try {
    const lists = await fetchFilterLists(context);
    const list = lists.find((l) => l.name === listName);
    if (!list) {
      throw new Error(`List not found: ${listName}`);
    }

    const before = list.custom_filters.map((f) => f.name.toLowerCase());
    const present = before.filter((d) => toRemove.has(d));
    logger.info(`List ${list.name} (${list.id}): ${before.length} domains`);
    logger.info(`Present targets: ${present.join(", ") || "(none)"}`);
    if (present.length === 0) {
      return;
    }

    const kept = list.custom_filters.filter((f) => !toRemove.has(f.name.toLowerCase()));
    const csrf = await readCsrfToken(context);
    const headers = buildAddDomainsHeaders(csrf);

    // Try several observed-ish mutation shapes.
    const attempts: Array<{ label: string; body: unknown }> = [
      {
        label: "custom_domains_to_remove",
        body: { custom_domains_to_remove: present },
      },
      {
        label: "custom_filters replacement (kept only)",
        body: {
          custom_filters: kept.map((f) => ({ id: f.id, name: f.name })),
        },
      },
      {
        label: "filter_list.custom_filters",
        body: {
          filter_list: {
            custom_filters: kept.map((f) => ({ id: f.id, name: f.name })),
          },
        },
      },
    ];

    for (const attempt of attempts) {
      logger.info(`Trying ${attempt.label}…`);
      const res = await context.request.patch(`${FREEDOM_ORIGIN}/filter_lists/${list.id}`, {
        data: attempt.body,
        headers,
        failOnStatusCode: false,
        timeout: 60_000,
      });
      const text = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
      logger.info(`  -> HTTP ${res.status()} ${text}`);
      if (res.ok()) {
        const refreshed = (await fetchFilterLists(context)).find((l) => l.id === list.id);
        const still = (refreshed?.custom_filters ?? [])
          .map((f) => f.name.toLowerCase())
          .filter((d) => toRemove.has(d));
        logger.info(
          `After: count=${refreshed?.count_websites ?? "?"} remaining targets=${still.join(", ") || "none"}`,
        );
        if (still.length === 0) {
          logger.info("Removed successfully.");
          return;
        }
      }
    }

    // Per-filter DELETE probe for the first present domain.
    const sample = list.custom_filters.find((f) => toRemove.has(f.name.toLowerCase()));
    if (sample) {
      for (const path of [
        `/filter_lists/${list.id}/custom_filters/${encodeURIComponent(sample.id)}`,
        `/custom_filters/${encodeURIComponent(sample.id)}`,
        `/filter_lists/${list.id}/filters/${encodeURIComponent(sample.id)}`,
      ]) {
        logger.info(`Trying DELETE ${path}`);
        const res = await context.request.delete(`${FREEDOM_ORIGIN}${path}`, {
          headers,
          failOnStatusCode: false,
          timeout: 30_000,
        });
        logger.info(`  -> HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
      }
    }

    throw new Error("Could not remove domains via probed APIs; remove them in the Freedom UI.");
  } finally {
    await closeFreedomContext(context);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
