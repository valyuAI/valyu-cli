import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseResponseLength } from '../../lib/parsers.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';
import { jobsSubcommand } from './jobs.js';

const EXTRACT_EFFORTS = ['auto', 'normal', 'high'] as const;

const contentsCmd = new Command('contents')
  .description('Extract clean content from web pages')
  .argument('[urls...]', 'URLs to extract content from (up to 50 with --async; 10 sync)')
  .option('-s, --summary [instructions]', 'Generate AI summary (optional: custom instructions)')
  .option(
    '-l, --length <length>',
    'Response length: short (25k), medium (50k), large (100k), max, or positive integer',
    'medium',
  )
  .option(
    '--structured <schema>',
    'JSON schema for structured extraction (inline JSON string). Routes through the `summary` field',
  )
  .option(
    '--structured-file <path>',
    'JSON schema for structured extraction (file path)',
  )
  .option(
    '--extract-effort <effort>',
    `Render effort: ${EXTRACT_EFFORTS.join(', ')} (default auto - picks per URL; "high" forces full browser rendering for JS-heavy pages)`,
    'auto',
  )
  .option('--screenshot', 'Capture a page screenshot; url appears in result.screenshot_url')
  .option('--async', 'Process asynchronously - required when submitting more than 10 URLs; returns a job_id for polling')
  .option('--webhook-url <url>', 'HTTPS URL to receive async completion webhook (HMAC-signed)')
  .option('--max-price-dollars <number>', 'Maximum budget in USD for this request')
  .option('-w, --watch', 'When combined with --async, poll the job until complete and return the results inline')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu contents https://techcrunch.com/article')}
  ${pc.dim('$ valyu contents https://example.com --summary')}
  ${pc.dim('$ valyu contents https://paper.com --summary "Key findings in bullet points"')}
  ${pc.dim('$ valyu contents https://a.com https://b.com --json')}
  ${pc.dim('$ valyu contents https://product.com --structured \'{"name":"string","price":"number"}\'')}
  ${pc.dim('$ valyu contents https://dashboard.app --extract-effort high --screenshot')}
  ${pc.dim('$ valyu contents "$(cat urls.txt)" --async --webhook-url https://app.com/hook')}
  ${pc.dim('$ valyu contents jobs cj_abc123     # poll an existing async job')}
`,
  )
  .action(async (urls, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    // Stdin fallback when no positional args provided
    if (!urls || urls.length === 0) {
      const stdinData = await readStdin();
      if (stdinData) {
        urls = stdinData.split(/[\s\n]+/).map((u) => u.trim()).filter(Boolean);
      }
      if (!urls || urls.length === 0) {
        fail(
          `No URLs provided.\n\n  Usage: valyu contents https://example.com\n         valyu contents https://a.com https://b.com\n         echo "https://example.com" | valyu contents`,
          'missing_urls',
        );
        return;
      }
    }

    for (const url of urls) {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        fail(`Invalid URL: '${url}'. URLs must start with http:// or https://`, 'invalid_url');
        return;
      }
    }

    if (urls.length > 50) {
      fail('Maximum 50 URLs per request', 'too_many_urls');
      return;
    }
    if (urls.length > 10 && !opts.async) {
      fail('More than 10 URLs requires --async (the server returns a job_id to poll). Add --async (and optionally --watch to block until complete).', 'async_required');
      return;
    }

    if (!EXTRACT_EFFORTS.includes(opts.extractEffort as (typeof EXTRACT_EFFORTS)[number])) {
      fail(`Invalid --extract-effort '${opts.extractEffort}'. Valid: ${EXTRACT_EFFORTS.join(', ')}`, 'invalid_option');
      return;
    }

    if (opts.structured && opts.structuredFile) {
      fail('Use --structured or --structured-file, not both', 'invalid_options');
      return;
    }

    let structuredOutput: Record<string, unknown> | undefined;
    if (opts.structuredFile) {
      try {
        structuredOutput = JSON.parse(readFileSync(resolve(opts.structuredFile), 'utf-8'));
      } catch (err) {
        fail(
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `File not found: ${opts.structuredFile}`
            : `Invalid JSON in ${opts.structuredFile}`,
          'invalid_schema',
        );
        return;
      }
    } else if (opts.structured) {
      try {
        structuredOutput = JSON.parse(opts.structured);
      } catch {
        fail('Invalid JSON for --structured schema. Tip: use --structured-file to read from a file.', 'invalid_schema');
        return;
      }
    }

    let responseLength: string | number | undefined;
    try {
      responseLength = parseResponseLength(opts.length);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Invalid --length', 'invalid_option');
      return;
    }

    const maxPriceDollars = opts.maxPriceDollars != null ? parseFloat(opts.maxPriceDollars) : undefined;
    if (maxPriceDollars != null && (!Number.isFinite(maxPriceDollars) || maxPriceDollars <= 0)) {
      fail('--max-price-dollars must be a positive number', 'invalid_option');
      return;
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
      responseLength,
      summary: wantSummary,
      summaryInstructions,
      structuredOutput,
      extractEffort: opts.extractEffort as 'auto' | 'normal' | 'high',
      screenshot: opts.screenshot,
      async: opts.async,
      webhookUrl: opts.webhookUrl,
      maxPriceDollars,
    });

    if (error) {
      spinner.fail('Content extraction failed');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = data as any;

    // Async path: server returned a job_id. Either return immediately (agent
    // will poll via `valyu contents jobs <id>`) or block with --watch.
    if (raw?.job_id && opts.async && !opts.watch) {
      spinner.stop(`Job created: ${pc.cyan(raw.job_id)}`);
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(raw, { json: true });
        return;
      }
      console.log('');
      console.log(`  ${pc.bold('Job ID:')}         ${pc.cyan(raw.job_id)}`);
      console.log(`  ${pc.bold('URLs queued:')}    ${raw.urls_total ?? urls.length}`);
      if (raw.webhook_secret) {
        console.log(`  ${pc.bold('Webhook secret:')} ${pc.dim(raw.webhook_secret)}`);
      }
      console.log('');
      console.log(`  ${pc.dim('Poll:')}  valyu contents jobs ${raw.job_id}`);
      console.log(`  ${pc.dim('Watch:')} valyu contents jobs ${raw.job_id} --watch`);
      console.log('');
      return;
    }

    // Poll-inline path: async+watch OR legacy behavior for large syncs
    const MAX_JOB_POLLS = 200; // 200 * 3s = 10 minutes
    let results: typeof data;
    if (raw?.job_id) {
      spinner.update('Processing URLs (async job)...');
      let jobPolls = 0;
      while (jobPolls < MAX_JOB_POLLS) {
        const { data: jobData, error: jobErr } = await client.getContentsJob(raw.job_id);
        if (jobErr) {
          spinner.fail('Job failed');
          outputError({ message: jobErr.message, code: jobErr.code }, { json: globalOpts.json });
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = jobData as any;
        if (job?.status === 'completed') {
          results = job as typeof data;
          break;
        }
        if (job?.status === 'failed') {
          spinner.fail('Job failed');
          outputError(
            { message: job.error ?? 'Async job failed', code: 'job_failed' },
            { json: globalOpts.json },
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        jobPolls++;
      }
      if (jobPolls >= MAX_JOB_POLLS) {
        spinner.fail('Job timed out after 10 minutes');
        outputError(
          { message: `Content extraction timed out. Job ID: ${raw.job_id}`, code: 'job_timeout' },
          { json: globalOpts.json },
        );
        return;
      }
    } else {
      results = data;
    }

    // At this point results is guaranteed non-null
    const res = results!;
    const processed = res.urls_processed ?? 0;
    const failed = res.urls_failed ?? 0;

    // Structured output mode
    if (structuredOutput) {
      spinner.stop('Structured extraction complete');

      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(res, { json: true });
        return;
      }

      console.log('');
      for (const item of res.results ?? []) {
        if (item.error) {
          console.log(`  ${pc.red('Failed:')} ${item.url} - ${item.error}`);
          continue;
        }
        // Structured data lives in item.content (or could be parsed from it)
        let parsed: unknown = item.content;
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            // Not JSON, render as-is
          }
        }
        if (typeof parsed === 'object' && parsed !== null) {
          console.log(pc.dim('  ' + item.url));
          console.log('');
          const formatted = JSON.stringify(parsed, null, 2);
          for (const line of formatted.split('\n')) {
            console.log(`  ${line}`);
          }
        } else {
          console.log(`  ${pc.dim(item.url)}`);
          console.log(`  ${String(parsed)}`);
        }
        console.log('');
      }

      if (res.total_cost != null) {
        console.log(`  ${pc.dim('Cost: $' + res.total_cost.toFixed(4))}`);
        console.log('');
      }
      return;
    }

    // Standard mode
    const msg = failed > 0 ? `${processed} extracted, ${failed} failed` : `${processed} URL${processed !== 1 ? 's' : ''} processed`;
    spinner.stop(msg);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(res, { json: true });
      return;
    }

    // Rich TTY rendering
    console.log('');
    const items = res.results ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.error) {
        console.log(`  ${pc.red(`${i + 1}.`)} ${pc.red('Failed:')} ${item.url}`);
        console.log(`     ${pc.dim(item.error)}`);
        console.log('');
        continue;
      }

      const num = pc.dim(`${i + 1}.`);
      const title = item.title ? pc.bold(item.title) : pc.bold('Untitled');
      console.log(`  ${num} ${title}`);

      // Show shortened URL
      try {
        const u = new URL(item.url);
        console.log(`     ${pc.dim(u.hostname + u.pathname)}`);
      } catch {
        console.log(`     ${pc.dim(item.url)}`);
      }

      // Content length
      const charCount = item.length ?? item.content?.length ?? 0;
      if (charCount > 0) {
        console.log(`     ${pc.dim(`${charCount.toLocaleString()} characters extracted`)}`);
      }

      // Summary
      if (item.summary) {
        console.log('');
        const summaryLines = item.summary.split('\n');
        for (const line of summaryLines) {
          console.log(`     ${pc.cyan(line)}`);
        }
      }

      console.log('');
    }

    if (res.total_cost != null) {
      console.log(`  ${pc.dim('Cost: $' + res.total_cost.toFixed(4))}`);
      console.log('');
    }
  });

contentsCmd.addCommand(jobsSubcommand);

export const contentsCommand = contentsCmd;
