import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey, type ResearchStatus } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { renderResearch } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';

const RESEARCH_MODELS = ['fast', 'lite', 'heavy'] as const;
type ResearchModel = (typeof RESEARCH_MODELS)[number];

const MODEL_DESCRIPTIONS: Record<ResearchModel, string> = {
  fast: '~5 min - quick lookups, simple questions',
  lite: '~10-20 min - balanced (default)',
  heavy: '~90 min - in-depth analysis',
};

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 1080; // 90 minutes max

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const createCmd = new Command('create')
  .description('Start a deep research task')
  .argument('<query>', 'Research query')
  .option(
    '-m, --model <model>',
    `Research depth: ${RESEARCH_MODELS.join(', ')} (default: lite)`,
    'lite',
  )
  .option('--pdf', 'Generate PDF output')
  .option('-w, --watch', 'Wait for completion and display result')
  .addHelpText(
    'after',
    `
${pc.dim('Research models:')}

${RESEARCH_MODELS.map((m) => `  ${pc.cyan(m.padEnd(8))} ${MODEL_DESCRIPTIONS[m]}`).join('\n')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu research create "AI infrastructure market analysis 2025"')}
  ${pc.dim('$ valyu research create "CRISPR therapeutics landscape" --model heavy --pdf')}
  ${pc.dim('$ valyu research create "Tesla competitive positioning" --watch')}
`,
  )
  .action(async (query, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    if (!RESEARCH_MODELS.includes(opts.model as ResearchModel)) {
      outputError(
        {
          message: `Invalid model '${opts.model}'. Must be one of: ${RESEARCH_MODELS.join(', ')}`,
          code: 'invalid_model',
        },
        { json: globalOpts.json },
      );
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    const spinner = createSpinner('Creating research task...', globalOpts.quiet);

    const { data, error } = await client.createResearch({
      query,
      model: opts.model,
      outputFormats: opts.pdf ? ['markdown', 'pdf'] : ['markdown'],
    });

    if (error) {
      spinner.fail('Failed to create research task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const task = data!;
    const taskId = task.id ?? task.task_id ?? '';
    spinner.stop(`Research task created: ${pc.cyan(taskId)}`);

    if (!opts.watch) {
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(task, { json: true });
        return;
      }

      console.log('');
      console.log(`  ${pc.bold('Task ID:')} ${pc.cyan(taskId)}`);
      console.log(`  ${pc.bold('Model:')}   ${task.model ?? opts.model}`);
      console.log(`  ${pc.bold('Status:')}  ${task.status}`);
      console.log('');
      console.log(`  ${pc.dim('Check status:')} ${pc.dim(`valyu research status ${taskId}`)}`);
      console.log(`  ${pc.dim('Watch until done:')} ${pc.dim(`valyu research watch ${taskId}`)}`);
      console.log('');
      return;
    }

    // Watch mode
    await watchResearch(client, taskId, globalOpts);
  });

const statusCmd = new Command('status')
  .description('Check the status of a research task')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    const spinner = createSpinner('Fetching status...', globalOpts.quiet);
    const { data, error } = await client.getResearchStatus(id);

    if (error) {
      spinner.fail('Failed to fetch status');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    spinner.stop(`Status: ${data!.status}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    renderResearch(data!, { quiet: globalOpts.quiet });
  });

const watchCmd = new Command('watch')
  .description('Poll a research task until complete and display the result')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    await watchResearch(client, id, globalOpts);
  });

async function watchResearch(
  client: ValyuClient,
  id: string,
  globalOpts: GlobalOpts,
): Promise<void> {
  let polls = 0;
  const spinner = createSpinner('Waiting for research to complete...', globalOpts.quiet);

  while (polls < MAX_POLLS) {
    const { data, error } = await client.getResearchStatus(id);

    if (error) {
      spinner.fail('Failed to fetch status');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const status = data as ResearchStatus;

    if (status.status === 'completed') {
      spinner.stop('Research complete');
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(status, { json: true });
        return;
      }
      renderResearch(status, { quiet: globalOpts.quiet });
      return;
    }

    if (status.status === 'failed' || status.status === 'cancelled') {
      spinner.fail(`Research ${status.status}`);
      outputError(
        {
          message: status.error ?? `Research task ${status.status}`,
          code: `research_${status.status}`,
        },
        { json: globalOpts.json },
      );
    }

    // Update spinner with progress
    if (status.progress) {
      const pct = Math.round((status.progress.current_step / status.progress.total_steps) * 100);
      spinner.update(`Researching... ${pct}% complete`);
    } else {
      spinner.update(`Researching... (${status.status})`);
    }

    await sleep(POLL_INTERVAL_MS);
    polls++;
  }

  spinner.fail('Timed out waiting for research to complete');
  outputError(
    {
      message: `Research task ${id} did not complete within the timeout. Use 'valyu research status ${id}' to check later.`,
      code: 'timeout',
    },
    { json: globalOpts.json },
  );
}

export const researchCommand = new Command('deepresearch')
  .description('Deep research with AI-synthesized reports')
  .addCommand(createCmd)
  .addCommand(statusCmd)
  .addCommand(watchCmd);
