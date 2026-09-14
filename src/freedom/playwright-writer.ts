import type { AddDomainsResult, FreedomWriter } from "./writer.js";

/**
 * UI fallback writer — not implemented.
 * HTTP writer is preferred after Phase 5 confirmed PATCH /filter_lists/:id.
 */
export class PlaywrightFreedomWriter implements FreedomWriter {
  async addDomains(_listId: number, domains: string[]): Promise<AddDomainsResult> {
    throw new Error(
      `PlaywrightFreedomWriter is not implemented (requested ${domains.length} domain(s)). ` +
        "Use HttpFreedomWriter.",
    );
  }
}
