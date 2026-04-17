import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';

const POLL_MS = 3000;
const MAX_POLLS = 200; // ~10 minutes

type JobStatus = 'pending' | 'processing' | 'completed' | 'partial' | 'failed';

export const jobsSubcommand = new Command('jobs')
  .description('Poll an async content-extraction job')
  .argument('<job_id>', 'Job ID returned by `valyu contents ... --async`')
  .option('-w, --watch', 'Poll every 3s until the job reaches a terminal state')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu contents jobs cj_abc123            # one-shot status check')}
  ${pc.dim('$ valyu contents jobs cj_abc123 --watch    # block until complete')}
  ${pc.dim('$ valyu contents jobs cj_abc123 --json     # structured output')}
`,
  )
  .action(async (jobId, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(`Checking job ${jobId.slice(0, 12)}...`, globalOpts.quiet);

    let polls = 0;
    while (true) {
      const { data, error } = await client.getContentsJob(jobId);
      if (error) {
        spinner.fail('Failed to fetch job');
        outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const job = data as any;
      const status = job?.status as JobStatus | undefined;

      const terminal = status === 'completed' || status === 'partial' || status === 'failed';

      if (!opts.watch || terminal) {
        spinner.stop(`Job ${jobId.slice(0, 12)}: ${status ?? '?'}`);
        if (globalOpts.json || !process.stdout.isTTY) {
          outputResult(job, { json: true });
          return;
        }
        renderJob(job);
        return;
      }

      // Watch loop: update progress
      const total = job?.urls_total;
      const processed = job?.urls_processed;
      const failed = job?.urls_failed;
      const batch = job?.current_batch;
      const batches = job?.total_batches;
      const parts: string[] = [];
      if (status) parts.push(String(status));
      if (processed != null && total != null) parts.push(`${processed}/${total} processed`);
      if (failed) parts.push(`${failed} failed`);
      if (batch != null && batches != null) parts.push(`batch ${batch}/${batches}`);
      spinner.update(parts.join(' · '));

      if (polls >= MAX_POLLS) {
        spinner.fail('Timed out polling job');
        outputError(
          { message: `Job ${jobId} did not complete within ${(MAX_POLLS * POLL_MS) / 1000}s`, code: 'job_timeout' },
          { json: globalOpts.json },
        );
        return;
      }
      polls++;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderJob(job: any): void {
  console.log('');
  console.log(`  ${pc.bold('Job:')}         ${pc.cyan(job?.job_id)}`);
  console.log(`  ${pc.bold('Status:')}      ${job?.status}`);
  if (job?.urls_total != null) {
    console.log(
      `  ${pc.bold('Progress:')}    ${job.urls_processed ?? 0}/${job.urls_total} processed, ${job.urls_failed ?? 0} failed`,
    );
  }
  if (job?.actual_cost_dollars != null) {
    console.log(`  ${pc.bold('Cost:')}        $${job.actual_cost_dollars.toFixed(4)}`);
  }
  if (Array.isArray(job?.results)) {
    console.log(`  ${pc.bold('Results:')}     ${job.results.length} items`);
  }
  if (job?.error) {
    console.log(`  ${pc.red('Error:')}       ${job.error}`);
  }
  console.log('');
}
