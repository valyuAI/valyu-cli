import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { renderContents } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';

export const contentsCommand = new Command('contents')
  .description('Extract clean content from web pages')
  .argument('<urls...>', 'URLs to extract content from (up to 10)')
  .option('-s, --summary [instructions]', 'Generate AI summary (optional: custom instructions)')
  .option(
    '-l, --length <length>',
    'Response length: short (25k), medium (50k), large (100k), max',
    'medium',
  )
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu contents https://techcrunch.com/article')}
  ${pc.dim('$ valyu contents https://example.com --summary')}
  ${pc.dim('$ valyu contents https://paper.com --summary "Key findings in bullet points"')}
  ${pc.dim('$ valyu contents https://a.com https://b.com --json')}
`,
  )
  .action(async (urls, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    if (urls.length > 10) {
      outputError(
        { message: 'Maximum 10 URLs per request', code: 'too_many_urls' },
        { json: globalOpts.json },
      );
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    const wantSummary = opts.summary !== undefined;
    const summaryInstructions =
      typeof opts.summary === 'string' ? opts.summary : undefined;

    const spinner = createSpinner(
      `Extracting${urls.length > 1 ? ` ${urls.length}` : ''} URL${urls.length > 1 ? 's' : ''}...`,
      globalOpts.quiet,
    );

    const { data, error } = await client.contents({
      urls,
      responseLength: opts.length,
      summary: wantSummary,
      summaryInstructions,
    });

    if (error) {
      spinner.fail('Content extraction failed');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const processed = data!.urls_processed;
    const failed = data!.urls_failed;
    const msg = failed > 0 ? `${processed} extracted, ${failed} failed` : `${processed} extracted`;
    spinner.stop(msg);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    renderContents(data!.results, { quiet: globalOpts.quiet });
  });
