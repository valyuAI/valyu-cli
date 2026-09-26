import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { Datasource, GlobalOpts } from '../../lib/client.js';
import { PRICING_URL, ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { getPlanCoverage, isLocked, loadCatalog, rankSources, type Catalog, type PlanCoverage } from '../../lib/sources.js';
import { createSpinner } from '../../lib/spinner.js';

// Display-only and schema fields: most of the catalog payload, none of it
// needed to pick a dataset.
const OMIT = new Set(['response_schema', 'accent_color', 'icon', 'logo_url', 'sort_order']);

function compactSource(s: Datasource, coverage: PlanCoverage | undefined): Record<string, unknown> {
  const out = Object.fromEntries(Object.entries(s).filter(([k]) => !OMIT.has(k)));
  return coverage ? { ...out, locked: isLocked(coverage, s.id) } : out;
}

function oneLine(text: string | undefined, max = 150): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function planLine(catalog: Catalog, coverage: PlanCoverage | undefined): string | undefined {
  if (!coverage) return undefined;
  const plan = coverage.plan ?? 'current plan';
  const locked = catalog.sources.filter((s) => isLocked(coverage, s.id)).length;
  if (!locked) return `Plan: ${plan} - every dataset shown is included.`;
  return (
    `Plan: ${plan} - ${locked} of ${catalog.sources.length} datasets are outside it (LOCKED). ` +
    `An unscoped search is automatically restricted to what the plan covers. A LOCKED dataset may still ` +
    `have been granted to your organisation separately. Plans: ${PRICING_URL}`
  );
}

export const sourcesCommand = new Command('sources')
  .description('Find dataset ids for `valyu search --include-source`: best matches for the data you need, or the full catalog')
  .argument('[query...]', 'The data you need in plain language, e.g. "FDA drug labels" (omit to list everything)')
  .option('-c, --category <id>', 'Only datasets in this category')
  .addHelpText(
    'after',
    `
Cheap and worth running before scoping a search to papers, filings, data
series, trials, patents or case law: it returns the exact ids, and the example
queries show the phrasing each dataset answers. Never guess an id - an unknown
one is rejected rather than searched.

${pc.dim('Examples:')}

  ${pc.dim('$ valyu sources "peer-reviewed medical literature"')}
  ${pc.dim('$ valyu sources "insider transactions" -q')}
  ${pc.dim('$ valyu sources')}
  ${pc.dim('$ valyu sources --category healthcare')}
`,
  )
  .action(async (words, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    // `valyu sources list` / `categories` were listings in earlier versions.
    const query = words.join(' ').trim().replace(/^(list|categories)$/, '');

    const { key } = requireApiKey(globalOpts);
    const client = new ValyuClient(key);
    const spinner = createSpinner(query ? 'Ranking datasets...' : 'Loading datasets...', globalOpts.quiet);

    const { catalog, error } = await loadCatalog(client, opts.category);
    if (!catalog) {
      spinner.fail('Failed to load datasets');
      return outputError({ message: error!.message, code: error!.code }, { json: globalOpts.json });
    }
    const [coverage, ranking] = await Promise.all([
      getPlanCoverage(key),
      query ? rankSources(client, query, catalog) : undefined,
    ]);
    const machine = globalOpts.json || !process.stdout.isTTY;

    if (ranking) {
      const hits = ranking.ranked.map((r) => ({ ...catalog.byId.get(r.id)!, score: r.score }));
      spinner.stop(`${hits.length} match${hits.length === 1 ? '' : 'es'}`);
      if (machine) {
        outputResult(
          {
            query,
            match: ranking.mode,
            plan: coverage?.plan,
            results: hits.map((h) => ({
              id: h.id,
              name: h.name,
              category: h.category,
              description: h.description,
              example_queries: h.example_queries,
              score: h.score,
              ...(coverage ? { locked: isLocked(coverage, h.id) } : {}),
            })),
          },
          { json: true },
        );
        return;
      }
      if (globalOpts.quiet) return;
      renderRanked(query, hits, ranking.mode, coverage);
      return;
    }

    spinner.stop(`${catalog.sources.length} datasets`);
    if (machine) {
      outputResult(
        {
          plan: coverage?.plan,
          categories: catalog.categories,
          datasources: catalog.sources.map((s) => compactSource(s, coverage)),
        },
        { json: true },
      );
      return;
    }
    if (globalOpts.quiet) return;
    renderCatalog(catalog, coverage);
  });

function lockedTag(coverage: PlanCoverage | undefined, id: string): string {
  return isLocked(coverage, id) ? `  ${pc.yellow('LOCKED')}` : '';
}

function renderRanked(
  query: string,
  hits: Array<Datasource & { score: number }>,
  mode: string,
  coverage: PlanCoverage | undefined,
): void {
  console.log('');
  if (!hits.length) {
    console.log(`  No dataset resembles "${query}". An unscoped ${pc.cyan('valyu search')} still covers the web and every dataset.`);
    console.log('');
    return;
  }
  console.log(`  ${pc.cyan(pc.bold('Closest datasets'))}  ${pc.dim(`"${query}" · ${mode} match, best first`)}`);
  console.log(`  ${pc.dim('─'.repeat(60))}`);
  hits.forEach((h, i) => {
    console.log('');
    console.log(`  ${pc.dim(`${String(i + 1).padStart(2)}.`)} ${pc.bold(h.id)}${lockedTag(coverage, h.id)}`);
    console.log(`      ${pc.dim(oneLine(h.description))}`);
    const examples = (h.example_queries ?? []).slice(0, 3);
    if (examples.length) console.log(`      ${pc.dim('Phrase queries like: ' + examples.map((q) => `"${q}"`).join(', '))}`);
  });
  console.log('');
  console.log(`  ${pc.dim('Next:')} valyu search "<query>" --include-source ${hits[0].id}`);
  console.log(
    `  ${pc.dim('Scoping gives precision; an unscoped search (the live web plus every dataset) gives breadth. Run both and combine.')}`,
  );
  console.log('');
}

function renderCatalog(catalog: Catalog, coverage: PlanCoverage | undefined): void {
  const grouped = new Map<string, Datasource[]>();
  for (const s of catalog.sources) {
    const c = s.category ?? 'other';
    grouped.set(c, [...(grouped.get(c) ?? []), s]);
  }

  console.log('');
  console.log(`  ${pc.cyan(pc.bold('Datasets'))}  ${pc.dim(`(${catalog.sources.length})`)}`);
  const plan = planLine(catalog, coverage);
  if (plan) console.log(`  ${pc.dim(plan)}`);
  console.log(`  ${pc.dim('─'.repeat(60))}`);

  for (const [cat, items] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = catalog.categories[cat]?.name;
    console.log('');
    console.log(`  ${pc.bold(name ?? cat)}  ${pc.dim(`--category ${cat}`)}`);
    for (const s of items) {
      console.log(`    ${s.id}${lockedTag(coverage, s.id)}`);
      console.log(`    ${pc.dim(oneLine(s.description, 100))}`);
    }
  }
  console.log('');
  console.log(`  ${pc.dim('Find by need:')} valyu sources "<the data you need>"`);
  console.log(`  ${pc.dim('Search one:  ')} valyu search "<query>" --include-source <id>`);
  console.log('');
}
