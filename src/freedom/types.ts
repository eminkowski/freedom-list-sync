export interface FreedomCustomFilter {
  id: string;
  name: string;
}

/**
 * Freedom filter list as returned by GET /filter_lists/.
 *
 * Observed additional fields (ignored for sync today):
 * - curated_filters, apps
 * - block_all_websites, block_apps, schedule_property_adapter
 * - count_common_filters, count_category_filters, count_*_apps, etc.
 */
export interface FreedomFilterList {
  id: number;
  name: string;
  count_websites: number;
  custom_filters: FreedomCustomFilter[];
}

export interface FreedomFilterListsResponse {
  filter_lists: FreedomFilterList[];
  /** Observed in live responses alongside filter_lists. */
  status?: number | string;
}