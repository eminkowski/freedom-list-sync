export interface DomainDiff {
  additions: string[];
  removals: string[];
  unchangedCount: number;
}

/**
 * Compare source domains against Freedom domains.
 *
 * additions = source - Freedom
 * removals  = Freedom - source
 */
export function diffDomains(
  sourceDomains: Iterable<string>,
  freedomDomains: Iterable<string>,
): DomainDiff {
  const source = new Set(sourceDomains);
  const freedom = new Set(freedomDomains);

  const additions: string[] = [];
  const removals: string[] = [];
  let unchangedCount = 0;

  for (const domain of source) {
    if (freedom.has(domain)) {
      unchangedCount += 1;
    } else {
      additions.push(domain);
    }
  }

  for (const domain of freedom) {
    if (!source.has(domain)) {
      removals.push(domain);
    }
  }

  additions.sort();
  removals.sort();

  return { additions, removals, unchangedCount };
}
