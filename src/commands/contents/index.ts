import { readFileSync } from 'node:fs';
import { Command, Option } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { ContentsResult, GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseResponseLength } from '../../lib/compat.js';
import { clipResults, renderContents } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';

const EXTRACT_EFFORTS = ['auto', 'normal', 'high'] as const;
type ExtractEffort = (typeof EXTRACT_EFFORTS)[number];
const MAX_URLS = 10;

export function contentsHint(res: ContentsResult, clipped: number, responseLength: number): string | undefined {
  const results = res.results ?? [];
  if (!results.length || results.every((r) => r.error)) {
    return (
      "No content could be extracted - each result's error says why. If a page is paywalled, JS-rendered " +
      'or blocking crawlers, retry with --extract-effort high, or find the content with `valyu search` instead.'
    );
  }
  if (clipped) {
    return (
      `${clipped} page${clipped === 1 ? ' was' : 's were'} truncated at ${responseLength} characters. ` +
      'Raise --response-length for the full text, or pass --summary for a condensed version.'
    );
  }
  return undefined;
}

export const contentsCommand = new Command('contents')
  .description('Fetch URLs as clean markdown - the full page text with navigation, ads and boilerplate stripped')
  .argument('[urls...]', `Up to ${MAX_URLS} http(s) URLs (or pipe them in, one per line)`)
  .option('-s, --summary [instructions]', 'Return a summary instead of the full text; optionally say what to extract')
  .option('-l, --response-length <chars>', 'Max characters per page, 500-200000', '30000')
  .option('--extract-effort <effort>', 'normal (fastest), high (renders JavaScript), or auto (picks per URL)', 'auto')
  .option('--screenshot', 'Also capture a full-page screenshot of each URL (link valid for about an hour)')
  // Earlier versions' options, still honoured (see compat.ts).
  .addOption(new Option('--length <length>').hideHelp())
  .addOption(new Option('--max-price-dollars <n>').hideHelp())
  .addOption(new Option('--structured <schema>').hideHelp())
  .addOption(new Option('--structured-file <path>').hideHelp())
  .addHelpText(
    'after',
    `
Use this when you already have a URL - a search result, a link someone pasted,
a document to quote accurately. To find pages, use ${pc.cyan('valyu search')}.

For heavy single-page apps pass ${pc.cyan('--extract-effort high')}. A summary is far
cheaper in tokens than the full text when you only need the gist.

${pc.dim('Examples:')}

  ${pc.dim('$ valyu contents https://example.com/paper')}
  ${pc.dim('$ valyu contents https://a.com https://b.com --summary "key financial figures only"')}
  ${pc.dim('$ valyu contents https://dashboard.app --extract-effort high --screenshot')}
  ${pc.dim('$ cat urls.txt | valyu contents -q')}
`,
  )
  .action(async (urls, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string): never => outputError({ message, code }, { json: globalOpts.json });

    // `--summary` takes an optional value, so `--summary https://x.com` would
    // read the URL as the instruction. A URL is never an instruction.
    let summary: boolean | string | Record<string, unknown> | undefined = opts.summary;
    if (typeof summary === 'string' && /^https?:\/\//.test(summary)) {
      urls = [summary, ...urls];
      summary = true;
    }
    if (!urls.length) {
      urls = ((await readStdin()) ?? '').split(/\s+/).filter(Boolean);
    }
    if (!urls.length) {
      return fail(
        'No URLs provided.\n\n  Usage: valyu contents https://example.com\n         echo "https://example.com" | valyu contents',
        'missing_urls',
      );
    }
    const invalid = urls.find((u) => !/^https?:\/\//.test(u));
    if (invalid) return fail(`Invalid URL: '${invalid}'. URLs must start with http:// or https://`, 'invalid_url');
    if (urls.length > MAX_URLS) {
      return fail(`At most ${MAX_URLS} URLs per call (got ${urls.length}). Split them into batches.`, 'too_many_urls');
    }
    if (!EXTRACT_EFFORTS.includes(opts.extractEffort as ExtractEffort)) {
      return fail(`Invalid --extract-effort '${opts.extractEffort}'. Valid: ${EXTRACT_EFFORTS.join(', ')}`, 'invalid_option');
    }
    let responseLength: { send: number | string; clipAt: number };
    try {
      const chosen = cmd.getOptionValueSource('responseLength') === 'default' && opts.length ? opts.length : opts.responseLength;
      responseLength = parseResponseLength(chosen, '--response-length', 500, 200_000);
      // A JSON schema for structured extraction travels in the summary field.
      if (opts.structured || opts.structuredFile) {
        summary = JSON.parse(opts.structuredFile ? readFileSync(opts.structuredFile, 'utf-8') : opts.structured!);
      }
    } catch (err) {
      return fail((err as Error).message, 'invalid_option');
    }

    const { key } = requireApiKey(globalOpts);
    const client = new ValyuClient(key);
    const spinner = createSpinner(`Extracting ${urls.length} URL${urls.length === 1 ? '' : 's'}...`, globalOpts.quiet);

    const { data, error } = await client.contents({
      urls,
      summary,
      responseLength: responseLength.send,
      extractEffort: opts.extractEffort as ExtractEffort,
      screenshot: opts.screenshot,
      legacy: { max_price_dollars: opts.maxPriceDollars === undefined ? undefined : Number(opts.maxPriceDollars) },
    });
    if (error) {
      spinner.fail('Content extraction failed');
      return fail(error.message, error.code ?? 'contents_failed');
    }

    const { results, clipped } = clipResults(data!.results ?? [], responseLength.clipAt);
    const res: ContentsResult = { ...data!, results };
    const hint = contentsHint(res, clipped, responseLength.clipAt);

    const failed = results.filter((r) => r.error).length;
    spinner.stop(failed ? `${results.length - failed} extracted, ${failed} failed` : `${results.length} extracted`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(hint ? { ...res, hint } : res, { json: true });
      return;
    }
    renderContents(results, { cost: res.total_cost_dollars, hint, quiet: globalOpts.quiet });
  });
