import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { renderSearchResults } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';

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

export const searchCommand = new Command('search')
  .description('Search across web, academic, financial, and specialized sources')
  .argument('<type_or_query>', 'Search type or query (type defaults to web if omitted)')
  .argument('[query]', 'Search query (if first arg is a type)')
  .option('-n, --limit <number>', 'Number of results (default: 10)', '10')
  .option('--max-price <number>', 'Maximum price per search in USD')
  .addHelpText(
    'after',
    `
${pc.dim('Search types:')}

${SEARCH_TYPES.map((t) => `  ${pc.cyan(t.padEnd(12))} ${SEARCH_TYPE_DESCRIPTIONS[t]}`).join('\n')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu search "AI agent infrastructure 2025"')}
  ${pc.dim('$ valyu search web "AI agent infrastructure 2025"')}
  ${pc.dim('$ valyu search paper "transformer attention mechanisms" -n 20')}
  ${pc.dim('$ valyu search finance "Apple Q4 2024 earnings"')}
  ${pc.dim('$ valyu search bio "CAR-T cell therapy clinical trials"')}
`,
  )
  .action(async (typeOrQuery, maybeQuery, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    // If second arg provided and first matches a type, use explicit type
    // Otherwise treat first arg as query, default type to web
    let type: string;
    let query: string;

    if (maybeQuery !== undefined && SEARCH_TYPES.includes(typeOrQuery as SearchType)) {
      type = typeOrQuery;
      query = maybeQuery;
    } else if (maybeQuery === undefined && SEARCH_TYPES.includes(typeOrQuery as SearchType)) {
      outputError(
        { message: `'${typeOrQuery}' is a search type — provide a query: valyu search ${typeOrQuery} "your query"`, code: 'missing_query' },
        { json: globalOpts.json },
      );
      return;
    } else {
      type = 'web';
      query = maybeQuery !== undefined ? `${typeOrQuery} ${maybeQuery}` : typeOrQuery;
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
      ...(maxPrice != null ? { maxPrice } : {}),
    });

    if (error) {
      spinner.fail('Search failed');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
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
