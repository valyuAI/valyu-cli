import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';

export const contentsCommand = new Command('contents')
  .description('Extract clean content from web pages')
  .argument('[urls...]', 'URLs to extract content from (up to 10)')
  .option('-s, --summary [instructions]', 'Generate AI summary (optional: custom instructions)')
  .option(
    '-l, --length <length>',
    'Response length: short (25k), medium (50k), large (100k), max',
    'medium',
  )
  .option(
    '--structured <schema>',
    'Structured output schema (JSON string defining extraction shape)',
  )
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu contents https://techcrunch.com/article')}
  ${pc.dim('$ valyu contents https://example.com --summary')}
  ${pc.dim('$ valyu contents https://paper.com --summary "Key findings in bullet points"')}
  ${pc.dim('$ valyu contents https://a.com https://b.com --json')}
  ${pc.dim('$ valyu contents https://product.com --structured \'{"name":"string","price":"number"}\'')}
`,
  )
  .action(async (urls, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    // Stdin fallback when no positional args provided
    if (!urls || urls.length === 0) {
      const stdinData = await readStdin();
      if (stdinData) {
        urls = stdinData.split('\n').map((u) => u.trim()).filter(Boolean);
      }
      if (!urls || urls.length === 0) {
        outputError(
          {
            message: `No URLs provided.\n\n  Usage: valyu contents https://example.com\n         valyu contents https://a.com https://b.com\n         echo "https://example.com" | valyu contents`,
            code: 'missing_urls',
          },
          { json: globalOpts.json },
        );
        return;
      }
    }

    // Validate URLs
    for (const url of urls) {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        outputError(
          { message: `Invalid URL: '${url}'. URLs must start with http:// or https://`, code: 'invalid_url' },
          { json: globalOpts.json },
        );
        return;
      }
    }

    if (urls.length > 10) {
      outputError(
        { message: 'Maximum 10 URLs per request', code: 'too_many_urls' },
        { json: globalOpts.json },
      );
      return;
    }

    // Parse structured output schema if provided
    let structuredOutput: Record<string, unknown> | undefined;
    if (opts.structured) {
      try {
        structuredOutput = JSON.parse(opts.structured);
      } catch {
        outputError(
          { message: 'Invalid JSON for --structured schema', code: 'invalid_schema' },
          { json: globalOpts.json },
        );
        return;
      }
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
      structuredOutput,
    });

    if (error) {
      spinner.fail('Content extraction failed');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = data as any;

    // Async job handling - API returns job_id for large requests
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
