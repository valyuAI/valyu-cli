import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseResponseLength, parseSourceBiases } from '../../lib/parsers.js';
import { renderSearchResults } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';

const SEARCH_TYPES = ['web', 'paper', 'bio', 'finance', 'sec', 'patent', 'economics', 'news'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const SEARCH_TYPE_DESCRIPTIONS: Record<SearchType, string> = {
  web: 'general web search',
  paper: 'academic papers (arXiv, PubMed, bioRxiv)',
  bio: 'biomedical research (PubMed, clinical trials, drug labels)',
  finance: 'financial data (stocks, SEC, earnings)',
  sec: 'SEC filings (10-K, 10-Q, 8-K)',
  patent: 'patent databases',
  economics: 'economic data (BLS, FRED, World Bank)',
  news: 'news articles',
};

const SEARCH_TYPE_OVERRIDES = ['all', 'web', 'proprietary', 'news'] as const;

const collect = (value: string, prev: string[] = []): string[] => [...prev, value];

export const searchCommand = new Command('search')
  .description('Search across web, academic, financial, and specialized sources')
  .argument('[type_or_query]', 'Search type or query (type defaults to web if omitted)')
  .argument('[query]', 'Search query (if first arg is a type)')
  .option('-n, --limit <number>', 'Number of results (1-20; higher on request)', '10')
  .option('--max-price <number>', 'Max budget in CPM (cost per mille tokens retrieved)')
  .option('--relevance-threshold <float>', 'Minimum relevance score for returned results (0.0-1.0, default 0.5)')
  .option('--search-type <type>', `Override search scope: ${SEARCH_TYPE_OVERRIDES.join(', ')}`)
  .option('--include-source <source>', 'Source to include (repeatable). Domains, dataset IDs, presets, or collection:NAME', collect, [] as string[])
  .option('--exclude-source <source>', 'Source to exclude (repeatable)', collect, [] as string[])
  .option('--source-bias <kv>', 'Bias a source by domain or path (repeatable). Format: <source>=<int> where int is -5..+5 (e.g. arxiv.org=5)', collect, [] as string[])
  .option('--instructions <text>', 'Natural-language ranking instructions (max 500 chars, ignored in --fast-mode)')
  .option('-l, --response-length <length>', 'Content length per result: short (25k), medium (50k), large (100k), max, or positive integer')
  .option('--start-date <date>', 'Earliest publication date (YYYY-MM-DD)')
  .option('--end-date <date>', 'Latest publication date (YYYY-MM-DD)')
  .option('--country <code>', 'ISO 3166-1 alpha-2 country code for geo-targeted web search')
  .option('--fast-mode', '[advanced] Skip query rewriting + reranking for lower latency (forces web-only, lower-quality results)')
  .option('--url-only', '[advanced] Return only URLs without content extraction (web / news only)')
  .option('--no-tool-call', 'Mark request as non-tool-call (affects query rewriting)')
  .addHelpText(
    'after',
    `
${pc.dim('Search types:')}

${SEARCH_TYPES.map((t) => `  ${pc.cyan(t.padEnd(12))} ${SEARCH_TYPE_DESCRIPTIONS[t]}`).join('\n')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu search "AI agent infrastructure"')}
  ${pc.dim('$ valyu search paper "transformer attention mechanisms" -n 20')}
  ${pc.dim('$ valyu search finance "NVDA Q4 earnings guidance"')}
  ${pc.dim('$ valyu search bio "CAR-T cell therapy clinical trials"')}
  ${pc.dim('$ valyu search "climate impact on agriculture" \\\\')}
  ${pc.dim('    --start-date 2024-01-01 --end-date 2024-12-31 \\\\')}
  ${pc.dim('    --include-source arxiv.org --include-source valyu/valyu-pubmed')}
  ${pc.dim('$ valyu search "quantum error correction" \\\\')}
  ${pc.dim('    --source-bias arxiv.org=5 --source-bias reddit.com=-4')}
`,
  )
  .action(async (typeOrQuery, maybeQuery, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    if (!typeOrQuery) {
      const stdinData = await readStdin();
      if (stdinData) {
        typeOrQuery = stdinData;
      } else {
        outputError(
          {
            message: `No query provided.\n\n  Usage: valyu search "your query"\n         valyu search paper "your query"\n         echo "query" | valyu search`,
            code: 'missing_query',
          },
          { json: globalOpts.json },
        );
        return;
      }
    }

    let type: string;
    let query: string;

    if (maybeQuery !== undefined && SEARCH_TYPES.includes(typeOrQuery as SearchType)) {
      type = typeOrQuery;
      query = maybeQuery;
    } else if (maybeQuery === undefined && SEARCH_TYPES.includes(typeOrQuery as SearchType)) {
      outputError(
        { message: `'${typeOrQuery}' is a search type - provide a query: valyu search ${typeOrQuery} "your query"`, code: 'missing_query' },
        { json: globalOpts.json },
      );
      return;
    } else {
      type = 'web';
      query = maybeQuery !== undefined ? `${typeOrQuery} ${maybeQuery}` : typeOrQuery;
    }

    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (opts.searchType && !SEARCH_TYPE_OVERRIDES.includes(opts.searchType as (typeof SEARCH_TYPE_OVERRIDES)[number])) {
      fail(`Invalid --search-type '${opts.searchType}'. Valid: ${SEARCH_TYPE_OVERRIDES.join(', ')}`, 'invalid_option');
      return;
    }

    let relevanceThreshold: number | undefined;
    if (opts.relevanceThreshold != null) {
      const n = Number(opts.relevanceThreshold);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        fail('--relevance-threshold must be a number between 0.0 and 1.0', 'invalid_option');
        return;
      }
      relevanceThreshold = n;
    }

    let sourceBiases: Record<string, number> | undefined;
    if (opts.sourceBias.length > 0) {
      try {
        sourceBiases = parseSourceBiases(opts.sourceBias);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Invalid --source-bias', 'invalid_option');
        return;
      }
    }

    let responseLength: string | number | undefined;
    try {
      responseLength = parseResponseLength(opts.responseLength);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Invalid --response-length', 'invalid_option');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const limit = parseInt(opts.limit ?? '10', 10);
    const maxPrice = opts.maxPrice ? parseFloat(opts.maxPrice) : undefined;

    const spinner = createSpinner(`Searching ${type}...`, globalOpts.quiet);

    const { data, error } = await client.search({
      query,
      searchType: type,
      maxNumResults: limit,
      maxPrice,
      relevanceThreshold,
      searchTypeOverride: opts.searchType,
      includedSources: opts.includeSource.length > 0 ? opts.includeSource : undefined,
      excludedSources: opts.excludeSource.length > 0 ? opts.excludeSource : undefined,
      sourceBiases,
      instructions: opts.instructions,
      responseLength,
      startDate: opts.startDate,
      endDate: opts.endDate,
      countryCode: opts.country,
      fastMode: opts.fastMode,
      urlOnly: opts.urlOnly,
      // Commander --no-tool-call produces opts.toolCall=false; defaults to true otherwise
      isToolCall: opts.toolCall,
    });

    if (error) {
      spinner.fail('Search failed');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Found ${data!.results.length} results`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    renderSearchResults(data!.results, {
      query,
      searchType: type,
      cost: data!.total_deduction_dollars,
      quiet: globalOpts.quiet,
    });
  });
