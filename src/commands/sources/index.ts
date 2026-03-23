import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey, type Datasource } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';

const CATEGORY_COLORS: Record<string, (s: string) => string> = {
  research: pc.cyan,
  healthcare: pc.green,
  patents: pc.yellow,
  markets: pc.blue,
  company: pc.magenta,
  economic: pc.cyan,
  predictions: pc.yellow,
  transportation: pc.green,
  legal: pc.blue,
  politics: pc.red,
};

function formatPrice(cpm: number): string {
  return `$${cpm.toFixed(2)}/M tokens`;
}

function renderSources(
  sources: Datasource[],
  opts: { category?: string; quiet?: boolean },
): void {
  if (opts.quiet) return;

  // Group by category
  const grouped: Record<string, Datasource[]> = {};
  for (const s of sources) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }

  console.log('');
  console.log(`  ${pc.cyan(pc.bold('Available Data Sources'))}  ${pc.dim(`(${sources.length} total)`)}`);
  console.log(`  ${pc.dim('─'.repeat(60))}`);

  for (const [cat, items] of Object.entries(grouped)) {
    const color = CATEGORY_COLORS[cat] ?? pc.white;
    console.log('');
    console.log(`  ${color(pc.bold(cat.toUpperCase()))}`);

    for (const src of items) {
      const price = pc.dim(`· ${formatPrice(src.pricing.cpm)}`);
      const freq = src.update_frequency ? pc.dim(` · ${src.update_frequency}`) : '';
      console.log(`    ${pc.bold(src.id)}  ${price}${freq}`);
      console.log(`    ${pc.dim(src.description.slice(0, 90) + (src.description.length > 90 ? '...' : ''))}`);
      if (src.example_queries.length > 0) {
        console.log(`    ${pc.dim('e.g. "' + src.example_queries[0] + '"')}`);
      }
    }
  }

  console.log('');
  console.log(`  ${pc.dim('Use with:')} ${pc.dim('valyu search <type> "<query>"')}`);
  console.log(`  ${pc.dim('Filter by category:')} ${pc.dim('valyu sources --category markets')}`);
  console.log('');
}

export const sourcesCommand = new Command('sources')
  .description('List all available data sources')
  .option('-c, --category <name>', 'Filter by category (research, healthcare, markets, company, economic, patents...)')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu sources')}
  ${pc.dim('$ valyu sources --category markets')}
  ${pc.dim('$ valyu sources --category research')}
`,
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    const spinner = createSpinner('Loading data sources...', globalOpts.quiet);

    const { data, error } = await client.listDatasources(opts.category);

    if (error) {
      spinner.fail('Failed to load sources');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const sources = data!.datasources ?? [];
    spinner.stop(`${sources.length} sources available`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    renderSources(sources, { category: opts.category, quiet: globalOpts.quiet });
  });
