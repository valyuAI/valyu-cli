import { AccountClient } from './account-client.js';
import type { Datasource, DatasourceCategory, ValyuApiError, ValyuClient } from './client.js';

export interface Catalog {
  sources: Datasource[];
  byId: Map<string, Datasource>;
  categories: Record<string, DatasourceCategory>;
}

/** Read fresh every time, so a newly launched dataset is usable at once. */
export async function loadCatalog(
  client: ValyuClient,
  category?: string,
): Promise<{ catalog: Catalog | null; error: ValyuApiError | null }> {
  const { data, error } = await client.listDatasources(category);
  if (error || !data) return { catalog: null, error: error ?? { message: 'Empty catalog', code: 'empty_catalog' } };
  const sources = data.datasources ?? [];
  return {
    catalog: { sources, byId: new Map(sources.map((s) => [s.id, s])), categories: data.categories ?? {} },
    error: null,
  };
}

// ─── Resolving --include-source / --exclude-source ───────────────────────────

/**
 * Preset scopes the search API expands inside `included_sources`. These are
 * the API's own groupings, not catalog category ids, and the API does not
 * expand them in `excluded_sources`.
 */
const PRESETS = new Set([
  'academic', 'automotive', 'chemistry', 'compliance', 'cybersecurity', 'earnings',
  'environment', 'finance', 'genomics', 'health', 'legal', 'medical', 'patent',
  'patents', 'physics', 'politics', 'pulse', 'transportation',
]);

export interface UnresolvedSource {
  token: string;
  didYouMean: string[];
}

function isDomainOrUrl(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return true;
  if (/\s/.test(token)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(token);
}

/**
 * Check scope values before they reach the API. One unrecognised value fails
 * the whole search upstream, so a typo would otherwise cost the caller every
 * result. Accepted as given: exact dataset ids, domains and URL prefixes,
 * `web`, presets and `collection:NAME`. A bare name such as "pubmed" is not
 * rewritten into an id - that would search a source the caller never named -
 * it comes back with suggestions instead.
 */
export function resolveSources(
  tokens: string[],
  catalog: Catalog,
  { allowPresets = true }: { allowPresets?: boolean } = {},
): { ids: string[]; unresolved: UnresolvedSource[] } {
  const ids = new Set<string>();
  const unresolved: UnresolvedSource[] = [];

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const lower = token.toLowerCase();

    if (lower === 'web') {
      ids.add('web');
    } else if (lower.startsWith('collection:') || PRESETS.has(lower)) {
      if (allowPresets) ids.add(lower.startsWith('collection:') ? token : lower);
      else unresolved.push({ token, didYouMean: [] });
    } else if (isDomainOrUrl(token) || catalog.byId.has(token)) {
      ids.add(token);
    } else {
      unresolved.push({ token, didYouMean: suggest(token, catalog) });
    }
  }
  return { ids: [...ids], unresolved };
}

/** Closest dataset ids for a value that did not resolve: topical match first, then typo distance. */
function suggest(token: string, catalog: Catalog): string[] {
  const topical = rankLocally(token, catalog, 4).map((r) => r.id);
  const bare = (id: string) => (id.split('/').pop() ?? id).replace(/^valyu-/, '');
  const wanted = token.replace(/^valyu\/(valyu-)?/i, '');
  const typos = catalog.sources
    .map((s) => ({ id: s.id, score: similarity(wanted, bare(s.id)) }))
    .filter((x) => x.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.id);
  return [...new Set([...topical, ...typos])].slice(0, 4);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  let hits = 0;
  for (let i = 0; i < x.length - 1; i++) if (y.includes(x.slice(i, i + 2))) hits++;
  return hits / Math.max(1, x.length - 1);
}

// ─── Ranking the catalog for `valyu sources <query>` ─────────────────────────

const STOP = new Set(['valyu', 'dataset', 'datasets', 'data', 'the', 'a', 'of', 'for', 'and']);

function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Lexical ranking: query-token coverage over each dataset's id, name,
 * description, topics and example queries, with id/name hits weighted up.
 * Always returns the closest datasets rather than nothing, because an empty
 * answer from a discovery command reads as "this does not exist".
 */
export function rankLocally(query: string, catalog: Catalog, limit = 8): Array<{ id: string; score: number }> {
  const q = [...tokensOf(query)].filter((t) => !STOP.has(t));
  if (!q.length) return [];
  return catalog.sources
    .map((s) => {
      const category = catalog.categories[s.category];
      const doc = tokensOf(
        [s.id, s.name, s.description, s.category, category?.name, ...(s.topics ?? []), ...(s.example_queries ?? [])]
          .filter(Boolean)
          .join(' '),
      );
      const head = tokensOf(`${s.id} ${s.name ?? ''}`);
      const hit = q.filter((t) => doc.has(t)).length;
      const headHit = q.filter((t) => head.has(t)).length;
      return { id: s.id, score: hit / q.length + 0.5 * (headHit / q.length) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Semantic ranking from the API, falling back to lexical when it is unavailable or empty. */
export async function rankSources(
  client: ValyuClient,
  query: string,
  catalog: Catalog,
  limit = 8,
): Promise<{ ranked: Array<{ id: string; score: number }>; mode: 'semantic' | 'lexical' }> {
  const { data } = await client.searchDatasources(query, limit);
  const ranked = (data?.results ?? [])
    .filter((r) => catalog.byId.has(r.id))
    .map((r) => ({ id: r.id, score: r.relevance_score ?? 0 }));
  if (ranked.length) return { ranked, mode: 'semantic' };
  return { ranked: rankLocally(query, catalog, limit), mode: 'lexical' };
}

// ─── Plan coverage ───────────────────────────────────────────────────────────

/** Published plan names (see the pricing page). Unknown tiers show no name. */
const PLAN_NAMES: Record<string, string> = {
  tier_0: 'Pay As You Go',
  tier_1: 'Ridiculously Cheap',
  tier_2: 'Comfortably Pro',
  tier_3: 'Serious Business',
};
const TOP_TIER = 'tier_3';

export interface PlanCoverage {
  plan?: string;
  /** True when nothing in the catalog is outside the plan. */
  fullAccess: boolean;
  allowed: Set<string>;
}

/**
 * What the key's plan covers, or undefined when it cannot be established.
 * Never fails the caller: coverage is an annotation. The account API's list
 * can under-report datasets granted to an organisation individually, so a
 * dataset outside it is "probably locked", never "unreachable", and the top
 * plan is treated as covering everything.
 */
export async function getPlanCoverage(apiKey: string, catalogIds: string[]): Promise<PlanCoverage | undefined> {
  try {
    const { data } = await new AccountClient(apiKey).me();
    if (!data || (!data.tier && !data.allowed_datasets?.length)) return undefined;
    const allowed = new Set(data.allowed_datasets ?? []);
    return {
      plan: PLAN_NAMES[data.tier],
      fullAccess: data.tier === TOP_TIER || catalogIds.every((id) => allowed.has(id)),
      allowed,
    };
  } catch {
    return undefined;
  }
}

export function isLocked(coverage: PlanCoverage | undefined, id: string): boolean {
  return Boolean(coverage && !coverage.fullAccess && id !== 'web' && !coverage.allowed.has(id));
}
