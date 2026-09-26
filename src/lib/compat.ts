// Keeps scripts written against earlier versions working. Nothing here is
// shown in --help or the agent skill; new usage goes through the plain flags.

/**
 * `valyu search <type> <query>` from earlier versions, sent exactly as before
 * so a script that asked for papers still gets papers. The type names a scope
 * the caller chose, which is the one case where scoping is right.
 */
export const LEGACY_SEARCH_SCOPES: Record<string, { search_type: string; included_sources?: string[] }> = {
  web: { search_type: 'web' },
  news: { search_type: 'news' },
  paper: {
    search_type: 'proprietary',
    included_sources: ['valyu/valyu-arxiv', 'valyu/valyu-biorxiv', 'valyu/valyu-medrxiv', 'valyu/valyu-pubmed'],
  },
  bio: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-pubmed',
      'valyu/valyu-biorxiv',
      'valyu/valyu-medrxiv',
      'valyu/valyu-clinical-trials',
      'valyu/valyu-drug-labels',
    ],
  },
  finance: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-stocks',
      'valyu/valyu-sec-filings',
      'valyu/valyu-earnings-US',
      'valyu/valyu-balance-sheet-US',
      'valyu/valyu-income-statement-US',
      'valyu/valyu-cash-flow-US',
      'valyu/valyu-dividends-US',
      'valyu/valyu-insider-transactions-US',
      'valyu/valyu-crypto',
      'valyu/valyu-forex',
    ],
  },
  sec: { search_type: 'proprietary', included_sources: ['valyu/valyu-sec-filings'] },
  patent: { search_type: 'proprietary', included_sources: ['valyu/valyu-patents'] },
  economics: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-bls',
      'valyu/valyu-fred',
      'valyu/valyu-world-bank',
      'valyu/valyu-worldbank-indicators',
      'valyu/valyu-usaspending',
    ],
  },
};

export function legacyTypeNote(type: string): string {
  return (
    `note: \`valyu search ${type}\` is kept for existing scripts. A plain \`valyu search "<query>"\` now ` +
    'covers the web and every dataset; scope it with --include-source (see `valyu sources`).\n'
  );
}

/** Sizes earlier versions accepted by name. `max` has no fixed size. */
const NAMED_LENGTHS: Record<string, number> = { short: 25_000, medium: 50_000, large: 100_000, max: Infinity };

/**
 * A --response-length value: a character count within [min, max], or one of
 * the names earlier versions took. `send` goes to the API as given; `clipAt`
 * is the local per-result limit.
 */
export function parseResponseLength(
  value: string,
  flag: string,
  min: number,
  max: number,
): { send: number | string; clipAt: number } {
  if (Object.hasOwn(NAMED_LENGTHS, value)) return { send: value, clipAt: NAMED_LENGTHS[value] };
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be a whole number of characters from ${min} to ${max} (got '${value}').`);
  }
  return { send: n, clipAt: n };
}
