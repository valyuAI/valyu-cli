import { Command, Option } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts, SearchResult } from '../../lib/client.js';
import { PRICING_URL, ValyuClient, requireApiKey } from '../../lib/client.js';
import { LEGACY_SEARCH_SCOPES, legacyTypeNote, parseResponseLength } from '../../lib/compat.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseCountry, parseDate, parseIntOption, parseSourceBiases } from '../../lib/parsers.js';
import { clipResults, renderSearchResults } from '../../lib/render.js';
import {
  getPlanCoverage,
  isLocked,
  loadCatalog,
  resolveSources,
  type PlanCoverage,
  type UnresolvedSource,
} from '../../lib/sources.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';

const collect = (value: string, prev: string[] = []): string[] => [...prev, value];

export function unknownSourcesMessage(flag: string, unresolved: UnresolvedSource[]): string {
  const lines = unresolved.map((u) =>
    u.didYouMean.length
      ? `  - "${u.token}" - did you mean: ${u.didYouMean.join(', ')}?`
      : `  - "${u.token}"`,
  );
  const help =
    flag === '--exclude-source'
      ? '--exclude-source takes dataset ids, domains and URL prefixes. Presets and collections only work in --include-source.'
      : 'A dataset id must match `valyu sources` exactly; a domain or URL prefix (e.g. arxiv.org) is passed straight through. Or drop --include-source to search everything.';
  return `Unknown value in ${flag}:\n${lines.join('\n')}\n\n${help}`;
}

/**
 * What the caller should do next, when the results alone do not say. The API
 * reports a failed backend and a query that matched nothing identically
 * (HTTP 200, no results), and only the `error` string tells them apart.
 */
export function searchHint(
  res: SearchResult,
  ctx: { query: string; scoped: boolean; clipped: number; responseLength: number; locked: string[]; plan?: string },
): string | undefined {
  const results = res.results ?? [];
  const upstream = res.error?.trim() && !/^no results found/i.test(res.error.trim()) ? res.error.trim() : undefined;
  const hints: string[] = [];

  if (!results.length) {
    hints.push(
      upstream
        ? `Search could not complete: ${upstream}. This is an availability problem, not a problem with the query - rewording will not help. Retry in a few seconds.`
        : `No results for "${ctx.query}". Try a shorter query around its most distinctive term` +
            (ctx.scoped ? ', or drop --include-source and the date filters to search everything.' : '.'),
    );
  } else if (!results.some((r) => String(r.content ?? r.description ?? '').trim())) {
    hints.push(
      'These results matched but carry no data. For structured datasets this is almost always a date problem: ' +
        'drop --start-date/--end-date (periodic figures are stamped at the start of their period), or ask for "latest" ' +
        'instead of naming a recent month. Do not infer values from the titles.',
    );
  } else if (upstream) {
    hints.push(`Partial results: one or more backends failed (${upstream}). Retry for full coverage.`);
  }

  if (ctx.clipped) {
    hints.push(
      `${ctx.clipped} result${ctx.clipped === 1 ? ' was' : 's were'} trimmed to ${ctx.responseLength} characters. ` +
        'Raise --response-length to see more, or run `valyu contents <url>` for the full text of an open-web page.',
    );
  }
  if (ctx.locked.length) {
    const one = ctx.locked.length === 1;
    hints.push(
      `${ctx.locked.join(', ')} ${one ? 'is' : 'are'} outside the current plan${ctx.plan ? ` (${ctx.plan})` : ''}, ` +
        `so ${one ? 'it was' : 'they were'} likely skipped; these results cover the other sources. Plans: ${PRICING_URL}`,
    );
  }
  return hints.length ? hints.join('\n\n') : undefined;
}

export const searchCommand = new Command('search')
  .description('Search the web and specialised datasets - papers, filings, market data, trials, patents - in one call')
  .argument('[query...]', 'One short question or focused phrase (or pipe it in)')
  .option('-n, --limit <n>', 'Results to return, 1-100 (above 20 needs a key permission)', '10')
  .option('-l, --response-length <chars>', 'Max characters per result, 500-100000', '4000')
  .option(
    '--include-source <source>',
    '[advanced] Only search this source (repeatable): a dataset id from `valyu sources`, a domain, a URL prefix, a preset, or "web"',
    collect,
    [] as string[],
  )
  .option(
    '--exclude-source <source>',
    '[advanced] Leave out this source (repeatable): a dataset id, domain or URL prefix',
    collect,
    [] as string[],
  )
  .option(
    '--source-bias <source=n>',
    '[advanced] Rank a domain up or down, -5..+5, without excluding anything (repeatable)',
    collect,
    [] as string[],
  )
  .option('--start-date <date>', '[advanced] Only results published on or after this date (YYYY-MM-DD)')
  .option('--end-date <date>', '[advanced] Only results published on or before this date (YYYY-MM-DD)')
  .option('--country <code>', '[advanced] Bias web results to a country (ISO 3166-1 alpha-2, e.g. GB)')
  // Earlier versions' options, still honoured (see compat.ts).
  .addOption(new Option('--max-price <n>').hideHelp())
  .addOption(new Option('--relevance-threshold <n>').hideHelp())
  .addOption(new Option('--search-type <type>').hideHelp())
  .addOption(new Option('--instructions <text>').hideHelp())
  .addOption(new Option('--fast-mode').hideHelp())
  .addOption(new Option('--url-only').hideHelp())
  .addOption(new Option('--no-tool-call').hideHelp())
  .addHelpText(
    'after',
    `
Just pass a query - that is the right call for nearly every question. Routing
is automatic: one search covers the live web and every specialised dataset
your plan includes, and returns full-text results with a relevance score.

Write one short question or focused phrase around its most distinctive term.
No site:, quotes or AND/OR, and no year in the query - use --include-source
and --start-date for those.

The ${pc.dim('[advanced]')} options narrow or reweight what routing would do on its own,
so a wrong value quietly returns less. Set one only when the source, site,
country or date window was actually asked for. Find dataset ids with
${pc.cyan('valyu sources "<the data you need>"')}. For the newest value of a data
series, put "latest" in the query and pass no dates.

${pc.dim('Examples:')}

  ${pc.dim('$ valyu search "GLP-1 receptor agonists cardiovascular outcomes"')}
  ${pc.dim('$ valyu search "Apple 10-K Item 1A risk factors" --include-source valyu/valyu-sec-filings')}
  ${pc.dim('$ valyu search "rotary position embeddings" --include-source arxiv.org')}
  ${pc.dim('$ valyu search "quantum error correction" --source-bias arxiv.org=3 --source-bias reddit.com=-4')}
  ${pc.dim('$ echo "latest US CPI inflation" | valyu search -q')}
`,
  )
  .action(async (words, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string): never => outputError({ message, code }, { json: globalOpts.json });

    // Earlier versions read `<type> <query>` (or a lone type with the query
    // piped in); that form keeps its old scope.
    let query = words.join(' ').trim();
    let legacyType: string | undefined;
    if (words.length && words.length <= 2 && Object.hasOwn(LEGACY_SEARCH_SCOPES, words[0])) {
      const rest = words.length === 2 ? words[1] : await readStdin();
      if (rest) {
        legacyType = words[0];
        query = rest.trim();
        if (!globalOpts.quiet) process.stderr.write(`${pc.yellow(legacyTypeNote(legacyType))}`);
      }
    }
    if (!query) query = (await readStdin()) ?? '';
    if (!query) {
      return fail('No query provided.\n\n  Usage: valyu search "your query"\n         echo "your query" | valyu search', 'missing_query');
    }

    let limit: number;
    let responseLength: { send?: number | string; clipAt: number };
    let sourceBiases: Record<string, number> | undefined;
    let startDate: string | undefined;
    let endDate: string | undefined;
    let country: string | undefined;
    try {
      limit = parseIntOption(opts.limit, '--limit', 1, 100);
      responseLength = parseResponseLength(opts.responseLength, '--response-length', 500, 100_000);
      sourceBiases = opts.sourceBias.length ? parseSourceBiases(opts.sourceBias) : undefined;
      startDate = parseDate(opts.startDate, '--start-date');
      endDate = parseDate(opts.endDate, '--end-date');
      country = parseCountry(opts.country);
    } catch (err) {
      return fail((err as Error).message, 'invalid_option');
    }

    const { key } = requireApiKey(globalOpts);
    const client = new ValyuClient(key);
    const spinner = createSpinner('Searching...', globalOpts.quiet);

    // Scope values are checked against the live catalog first: one unknown
    // value fails the whole search upstream.
    let included: string[] | undefined;
    let excluded: string[] | undefined;
    let datasets: string[] = [];
    let plan: PlanCoverage | undefined;
    if (opts.includeSource.length || opts.excludeSource.length) {
      // The plan's dataset list also vouches for ids the catalog does not list.
      const [{ catalog, error }, coverage] = await Promise.all([loadCatalog(client), getPlanCoverage(key)]);
      plan = coverage;
      if (!catalog) {
        spinner.fail('Could not load the dataset catalog');
        return fail(error!.message, error!.code ?? 'catalog_failed');
      }
      for (const [flag, values] of [['--include-source', opts.includeSource], ['--exclude-source', opts.excludeSource]] as const) {
        if (!values.length) continue;
        const { ids, unresolved } = resolveSources(values, catalog, {
          allowPresets: flag === '--include-source',
          knownIds: plan?.allowed,
        });
        if (unresolved.length) {
          spinner.fail(`Unknown ${flag} value`);
          return fail(unknownSourcesMessage(flag, unresolved), 'unknown_source');
        }
        if (flag === '--include-source') included = ids;
        else excluded = ids;
      }
      datasets = (included ?? []).filter((id) => catalog.byId.has(id));
    }

    const scope = legacyType ? LEGACY_SEARCH_SCOPES[legacyType] : undefined;
    // The old form also keeps the old default length: whatever the API returns.
    if (scope && cmd.getOptionValueSource('responseLength') === 'default') {
      responseLength = { clipAt: Infinity };
    }
    const { data, error } = await client.search({
      query,
      maxNumResults: limit,
      responseLength: responseLength.send,
      includedSources: included ?? scope?.included_sources,
      excludedSources: excluded,
      sourceBiases,
      startDate,
      endDate,
      countryCode: country,
      legacy: {
        search_type: opts.searchType ?? scope?.search_type,
        max_price: opts.maxPrice === undefined ? undefined : Number(opts.maxPrice),
        relevance_threshold: opts.relevanceThreshold === undefined ? undefined : Number(opts.relevanceThreshold),
        instructions: opts.instructions,
        fast_mode: opts.fastMode || undefined,
        url_only: opts.urlOnly || undefined,
        is_tool_call: opts.toolCall === false ? false : undefined,
      },
    });
    if (error) {
      spinner.fail('Search failed');
      return fail(error.message, error.code ?? 'search_failed');
    }

    // The API applies response_length to text corpora but can return longer
    // chunks, so hold the per-result limit here too.
    const { results, clipped } = clipResults(data!.results ?? [], responseLength.clipAt);
    const res: SearchResult = { ...data!, results };

    const machine = globalOpts.json || !process.stdout.isTTY;
    const hint = searchHint(res, {
      query,
      scoped: Boolean(included?.length || excluded?.length || startDate || endDate),
      // The terminal view shows short previews, so trimming only matters to JSON readers.
      clipped: machine ? clipped : 0,
      responseLength: responseLength.clipAt,
      locked: datasets.filter((id) => isLocked(plan, id)),
      plan: plan?.plan,
    });

    spinner.stop(`${results.length} result${results.length === 1 ? '' : 's'}`);

    if (machine) {
      outputResult(hint ? { ...res, hint } : res, { json: true });
      return;
    }
    renderSearchResults(results, { query, cost: res.total_deduction_dollars, hint, quiet: globalOpts.quiet });
  });
