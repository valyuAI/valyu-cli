import { describe, expect, it } from 'vitest';
import type { Datasource } from '../lib/client.js';
import { parseCountry, parseDate, parseIntOption, parseKeyValues, parseSourceBiases } from '../lib/parsers.js';
import { isLocked, rankLocally, resolveSources, type Catalog } from '../lib/sources.js';
import { searchHint, unknownSourcesMessage } from '../commands/search/index.js';
import { contentsHint } from '../commands/contents/index.js';

function ds(id: string, name: string, description: string, extra: Partial<Datasource> = {}): Datasource {
  return {
    id,
    name,
    description,
    category: 'research',
    type: 'paper',
    topics: [],
    example_queries: [],
    pricing: { cpm: 1 },
    ...extra,
  };
}

const sources = [
  ds('valyu/valyu-arxiv', 'ArXiv', 'Pre-print research papers in physics, computer science and mathematics'),
  ds('valyu/valyu-pubmed', 'PubMed', 'Biomedical and life sciences literature', { topics: ['Medicine'] }),
  ds('valyu/valyu-sec-filings', 'SEC Filings', '10-K and 10-Q filings', { category: 'company', example_queries: ['Apple 10-K risk factors'] }),
];
const catalog: Catalog = {
  sources,
  byId: new Map(sources.map((s) => [s.id, s])),
  categories: { research: { name: 'Research' }, company: { name: 'Company' } },
};

describe('resolveSources', () => {
  it('passes dataset ids, domains, URL prefixes, presets, collections and web through', () => {
    const { ids, unresolved } = resolveSources(
      ['valyu/valyu-arxiv', 'arxiv.org', 'https://openai.com/index', 'Academic', 'collection:My-Set', 'web', 'arxiv.org'],
      catalog,
    );
    expect(unresolved).toEqual([]);
    expect(ids).toEqual(['valyu/valyu-arxiv', 'arxiv.org', 'https://openai.com/index', 'academic', 'collection:My-Set', 'web']);
  });

  it('does not rewrite a bare name into an id, but suggests it', () => {
    const { ids, unresolved } = resolveSources(['pubmed'], catalog);
    expect(ids).toEqual([]);
    expect(unresolved[0].token).toBe('pubmed');
    expect(unresolved[0].didYouMean[0]).toBe('valyu/valyu-pubmed');
  });

  it('catches a mistyped id', () => {
    const { unresolved } = resolveSources(['valyu/valyu-sec-filing'], catalog);
    expect(unresolved[0].didYouMean).toContain('valyu/valyu-sec-filings');
  });

  it('accepts ids the plan covers even when the catalog does not list them', () => {
    const knownIds = new Set(['valyu/valyu-fedwatch']);
    expect(resolveSources(['valyu/valyu-fedwatch'], catalog, { knownIds }).ids).toEqual(['valyu/valyu-fedwatch']);
    expect(resolveSources(['valyu/valyu-fedwatch'], catalog).unresolved).toHaveLength(1);
    expect(resolveSources(['valyu/valyu-fedwatc'], catalog, { knownIds }).unresolved[0].didYouMean).toContain('valyu/valyu-fedwatch');
  });

  it('refuses presets and collections when excluding', () => {
    const { ids, unresolved } = resolveSources(['finance', 'collection:x', 'reddit.com'], catalog, { allowPresets: false });
    expect(ids).toEqual(['reddit.com']);
    expect(unresolved.map((u) => u.token)).toEqual(['finance', 'collection:x']);
  });
});

describe('rankLocally', () => {
  it('ranks by description, topics and example queries', () => {
    expect(rankLocally('medicine literature', catalog)[0].id).toBe('valyu/valyu-pubmed');
    expect(rankLocally('10-K risk factors', catalog)[0].id).toBe('valyu/valyu-sec-filings');
  });

  it('returns nothing for filler words alone', () => {
    expect(rankLocally('the data', catalog)).toEqual([]);
  });
});

describe('isLocked', () => {
  const coverage = { plan: 'Pay As You Go', topTier: false, allowed: new Set(['valyu/valyu-arxiv']) };

  it('marks datasets outside the plan', () => {
    expect(isLocked(coverage, 'valyu/valyu-sec-filings')).toBe(true);
    expect(isLocked(coverage, 'valyu/valyu-arxiv')).toBe(false);
  });

  it('never marks anything when coverage is unknown or on the top plan', () => {
    expect(isLocked(undefined, 'valyu/valyu-sec-filings')).toBe(false);
    expect(isLocked({ ...coverage, topTier: true }, 'valyu/valyu-sec-filings')).toBe(false);
  });
});

describe('unknownSourcesMessage', () => {
  it('lists each bad value with its suggestions', () => {
    const msg = unknownSourcesMessage('--include-source', [{ token: 'pubmed', didYouMean: ['valyu/valyu-pubmed'] }]);
    expect(msg).toContain('"pubmed" - did you mean: valyu/valyu-pubmed?');
    expect(msg).toContain('valyu sources');
  });
});

describe('searchHint', () => {
  const base = { query: 'q', scoped: false, clipped: 0, responseLength: 4000, locked: [] as string[] };
  const result = { title: 't', url: 'https://x.com', source: 'web', content: 'body' };

  it('says nothing when the results speak for themselves', () => {
    expect(searchHint({ results: [result] }, base)).toBeUndefined();
  });

  it('tells an upstream failure apart from an empty match', () => {
    expect(searchHint({ results: [], error: 'finance search failed' }, base)).toContain('rewording will not help');
    expect(searchHint({ results: [], error: 'No results found' }, base)).toContain('No results for "q"');
  });

  it('suggests dropping the scope only when there was one', () => {
    expect(searchHint({ results: [] }, base)).not.toContain('--include-source');
    expect(searchHint({ results: [] }, { ...base, scoped: true })).toContain('drop --include-source');
  });

  it('flags results that carry no data', () => {
    expect(searchHint({ results: [{ ...result, content: '' }] }, base)).toContain('date problem');
  });

  it('reports trimming and datasets outside the plan', () => {
    const hint = searchHint({ results: [result] }, { ...base, clipped: 2, locked: ['valyu/valyu-sec-filings'], plan: 'Pay As You Go' });
    expect(hint).toContain('2 results were trimmed to 4000 characters');
    expect(hint).toContain('valyu/valyu-sec-filings is outside the current plan (Pay As You Go)');
  });
});

describe('contentsHint', () => {
  const ok = { url: 'https://x.com', content: 'text' };
  const res = (results: Array<Record<string, unknown>>) => ({ results, urls_requested: 1, urls_processed: 1, urls_failed: 0 }) as never;

  it('says how to recover when nothing was extracted', () => {
    expect(contentsHint(res([{ url: 'https://x.com', error: 'blocked' }]), 0, 30000)).toContain('--extract-effort high');
  });

  it('reports truncation', () => {
    expect(contentsHint(res([ok]), 1, 30000)).toContain('1 page was truncated at 30000 characters');
    expect(contentsHint(res([ok]), 0, 30000)).toBeUndefined();
  });
});

describe('parsers', () => {
  it('parseIntOption enforces whole numbers in range', () => {
    expect(parseIntOption('10', '--limit', 1, 100)).toBe(10);
    expect(() => parseIntOption('0', '--limit', 1, 100)).toThrow('--limit must be a whole number from 1 to 100');
    expect(() => parseIntOption('short', '--response-length', 500, 100000)).toThrow();
  });

  it('parseDate wants YYYY-MM-DD', () => {
    expect(parseDate('2026-01-15', '--start-date')).toBe('2026-01-15');
    expect(parseDate(undefined, '--start-date')).toBeUndefined();
    expect(() => parseDate('15/01/2026', '--start-date')).toThrow('YYYY-MM-DD');
  });

  it('parseCountry normalises a two-letter code', () => {
    expect(parseCountry('gb')).toBe('GB');
    expect(() => parseCountry('GBR')).toThrow('two-letter');
  });

  it('parseKeyValues coerces only exact numbers and booleans', () => {
    expect(parseKeyValues(['n=5', 'ok=true', 'cik=0000320193', 'ticker=0700', 'name=Apple'], '--param')).toEqual({
      n: 5,
      ok: true,
      cik: '0000320193',
      ticker: '0700',
      name: 'Apple',
    });
    expect(() => parseKeyValues(['=x'], '--param')).toThrow('Expected key=value');
  });

  it('parseSourceBiases rejects duplicates and out-of-range values', () => {
    expect(parseSourceBiases(['arxiv.org=5', 'reddit.com=-4'])).toEqual({ 'arxiv.org': 5, 'reddit.com': -4 });
    expect(() => parseSourceBiases(['arxiv.org=5', 'ArXiv.org=1'])).toThrow('twice');
    expect(() => parseSourceBiases(['arxiv.org=9'])).toThrow('-5 and +5');
    expect(() => parseSourceBiases(['arxiv.org'])).toThrow('Expected');
  });
});
