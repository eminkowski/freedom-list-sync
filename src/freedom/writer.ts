export interface AddDomainsResult {
  requested: number;
  countBefore?: number;
  countAfter?: number;
  addedCount?: number;
}

/**
 * Writer abstraction for adding domains to a Freedom blocklist.
 */
export interface FreedomWriter {
  addDomains(listId: number, domains: string[]): Promise<AddDomainsResult>;
}

export class UnsupportedFreedomWriter implements FreedomWriter {
  async addDomains(_listId: number, _domains: string[]): Promise<AddDomainsResult> {
    throw new Error(
      "Freedom writes are not implemented. Use HttpFreedomWriter or --dry-run.",
    );
  }
}
