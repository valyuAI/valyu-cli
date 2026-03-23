import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';

const MODES = ['fast', 'standard', 'heavy', 'max'] as const;
type Mode = (typeof MODES)[number];

const POLL_MS = 5000;
const MAX_POLLS = 1080;

function batchId(b: Record<string, unknown>): string {
  return String(b.batch_id ?? b.id ?? '');
}

function relTime(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  running: pc.yellow,
  queued: pc.yellow,
  completed: pc.green,
  failed: pc.red,
  cancelled: pc.dim,
};

function colorStatus(s: string): string {
  return (STATUS_COLOR[s] ?? pc.white)(s);
}

const TASK_ICON: Record<string, string> = {
  completed: pc.green('\u2713'),
  running: pc.yellow('\u2739'),
  queued: pc.dim('\u25CB'),
  failed: pc.red('\u2717'),
  cancelled: pc.dim('\u2717'),
};

function taskIcon(s: string): string {
  return TASK_ICON[s] ?? pc.dim('\u25CB');
}

// ─── create ─────────────────────────────────────────────────────────────────

const createCmd = new Command('create')
  .description('Create a batch of deep research tasks')
  .argument('<queries...>', 'Research queries')
  .option('-m, --mode <mode>', `Research depth: ${MODES.join(', ')} (default: standard)`, 'standard')
  .option('--no-pdf', 'Skip PDF generation')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu batch create "CRISPR gene therapy" "AI chip market" "Quantum computing"')}
  ${pc.dim('$ valyu batch create "Tesla analysis" "Apple analysis" --mode heavy')}
`,
  )
  .action(async (queries, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    if (!MODES.includes(opts.mode as Mode)) {
      outputError(
        {
          message: `Invalid mode '${opts.mode}'. Must be one of: ${MODES.join(', ')}`,
          code: 'invalid_mode',
        },
        { json: globalOpts.json },
      );
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(`Creating batch with ${queries.length} queries...`, globalOpts.quiet);

    const formats = opts.pdf === false ? ['markdown'] : ['markdown', 'pdf'];

    const { data, error } = await client.createBatch({
      queries,
      mode: opts.mode,
      outputFormats: formats,
    });

    if (error) {
      spinner.fail('Failed to create batch');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const batch = data! as Record<string, unknown>;
    const id = batchId(batch);
    spinner.stop(`Batch created: ${pc.cyan(id)}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(batch, { json: true });
      return;
    }

    console.log('');
    console.log(`  ${pc.bold('Batch ID:')}  ${pc.cyan(id)}`);
    console.log(`  ${pc.bold('Mode:')}      ${batch.mode ?? opts.mode}`);
    console.log(`  ${pc.bold('Tasks:')}     ${queries.length}`);
    console.log(`  ${pc.bold('PDF:')}       ${formats.includes('pdf') ? pc.green('yes') : pc.dim('no')}`);
    console.log('');
    console.log(`  ${pc.dim('Watch:')}   valyu batch watch ${id}`);
    console.log(`  ${pc.dim('Status:')}  valyu batch status ${id}`);
    console.log(`  ${pc.dim('Tasks:')}   valyu batch tasks ${id}`);
    console.log(`  ${pc.dim('Cancel:')}  valyu batch cancel ${id}`);
    console.log('');
  });

// ─── list ───────────────────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List all batches')
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading batches...', globalOpts.quiet);

    const { data, error } = await client.listBatches();

    if (error) {
      spinner.fail('Failed to list batches');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const raw = data as Record<string, unknown>[] | { data: Record<string, unknown>[] } | null;
    const batches: Record<string, unknown>[] = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.data as Record<string, unknown>[]) ?? [];
    spinner.stop(`${batches.length} batch${batches.length === 1 ? '' : 'es'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(batches, { json: true });
      return;
    }

    if (batches.length === 0) {
      console.log(`\n  ${pc.dim('No batches found. Create one with:')} valyu batch create "query1" "query2"\n`);
      return;
    }

    console.log('');
    console.log(`  ${pc.bold('Batches')}`);
    console.log(`  ${pc.dim('\u2500'.repeat(55))}`);
    for (const b of batches) {
      const id = batchId(b).slice(0, 8);
      const status = colorStatus(String(b.status ?? 'unknown'));
      const completed = Number(b.completed_tasks ?? b.completed ?? 0);
      const total = Number(b.total_tasks ?? b.total ?? 0);
      const mode = String(b.mode ?? '');
      const time = relTime(b.created_at as string | number | undefined);
      console.log(`  ${pc.cyan(id)}  ${status.padEnd(20)}  ${completed}/${total} tasks  ${pc.dim(mode.padEnd(10))}  ${pc.dim(time)}`);
    }
    console.log('');
  });

// ─── status ─────────────────────────────────────────────────────────────────

const statusCmd = new Command('status')
  .description('Check the status of a batch')
  .argument('<id>', 'Batch ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Fetching batch status...', globalOpts.quiet);

    const { data, error } = await client.getBatchStatus(id);

    if (error) {
      spinner.fail('Failed to fetch batch status');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const batch = data!;
    spinner.stop(`Status: ${colorStatus(String(batch.status))}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(batch, { json: true });
      return;
    }

    const bid = batchId(batch);
    const completed = Number(batch.completed_tasks ?? batch.completed ?? 0);
    const total = Number(batch.total_tasks ?? batch.total ?? 0);
    const running = Number(batch.running_tasks ?? batch.running ?? 0);
    const queued = total - completed - running;
    const cost = batch.cost ?? batch.total_cost;

    console.log('');
    console.log(`  ${pc.bold(`Batch ${bid}`)}`);
    console.log(`  ${pc.dim('\u2500'.repeat(55))}`);
    console.log(`  ${pc.bold('Mode:')}       ${batch.mode ?? 'standard'}`);
    console.log(`  ${pc.bold('Status:')}     ${colorStatus(String(batch.status))}`);
    console.log(`  ${pc.bold('Progress:')}   ${completed}/${total} completed  ${pc.dim('\u00B7')}  ${running} running  ${pc.dim('\u00B7')}  ${queued > 0 ? queued : 0} queued`);
    if (cost != null) {
      console.log(`  ${pc.bold('Cost:')}       ${pc.dim('$' + Number(cost).toFixed(2))}`);
    }
    console.log('');
    console.log(`  ${pc.dim(`Use 'valyu batch tasks ${bid.slice(0, 8)}' to see individual tasks.`)}`);
    console.log('');
  });

// ─── tasks ──────────────────────────────────────────────────────────────────

const tasksCmd = new Command('tasks')
  .description('List individual tasks in a batch')
  .argument('<id>', 'Batch ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading batch tasks...', globalOpts.quiet);

    const { data, error } = await client.listBatchTasks(id);

    if (error) {
      spinner.fail('Failed to list batch tasks');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const raw = data as Record<string, unknown>[] | { data: Record<string, unknown>[] } | null;
    const tasks: Record<string, unknown>[] = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.data as Record<string, unknown>[]) ?? [];
    spinner.stop(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(tasks, { json: true });
      return;
    }

    if (tasks.length === 0) {
      console.log(`\n  ${pc.dim('No tasks in this batch.')}\n`);
      return;
    }

    console.log('');
    console.log(`  ${pc.bold(`Tasks in batch ${id.slice(0, 8)}`)}`);
    console.log(`  ${pc.dim('\u2500'.repeat(55))}`);
    for (const t of tasks) {
      const tid = String(t.deepresearch_id ?? t.task_id ?? t.id ?? '').slice(0, 8);
      const status = String(t.status ?? 'unknown');
      const query = String(t.query ?? t.input ?? '');
      const q = query.length > 45 ? query.slice(0, 42) + '...' : query;
      console.log(`  ${taskIcon(status)} ${pc.cyan(tid)}  ${q.padEnd(45)}  ${colorStatus(status)}`);
    }
    console.log('');
  });

// ─── add ────────────────────────────────────────────────────────────────────

const addCmd = new Command('add')
  .description('Add queries to an existing batch')
  .argument('<id>', 'Batch ID')
  .argument('<queries...>', 'Research queries to add')
  .action(async (id, queries, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(`Adding ${queries.length} queries to batch...`, globalOpts.quiet);

    const { data, error } = await client.addBatchTasks(id, queries);

    if (error) {
      spinner.fail('Failed to add tasks');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    spinner.stop(`Added ${queries.length} task${queries.length === 1 ? '' : 's'} to batch ${pc.cyan(id.slice(0, 8))}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
    }
  });

// ─── watch ──────────────────────────────────────────────────────────────────

const watchCmd = new Command('watch')
  .description('Poll a batch until all tasks complete (omit ID to watch latest)')
  .argument('[id]', 'Batch ID (default: latest running batch)')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    let watchId = id;

    if (!watchId) {
      const spinner = createSpinner('Finding latest batch...', globalOpts.quiet);
      const { data, error } = await client.listBatches();
      if (error) {
        spinner.fail('Failed to list batches');
        outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      }
      const raw = data as Record<string, unknown>[] | { data: Record<string, unknown>[] } | null;
      const allBatches: Record<string, unknown>[] = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.data as Record<string, unknown>[]) ?? [];
      const running = allBatches.find(
        (b) => b.status === 'running' || b.status === 'queued',
      );
      if (!running) {
        spinner.fail('No running batches found');
        outputError(
          { message: 'No running batches. Create one with: valyu batch create "query1" "query2"', code: 'no_batches' },
          { json: globalOpts.json },
        );
        return;
      }
      watchId = batchId(running);
      spinner.stop(`Watching: ${pc.cyan(watchId.slice(0, 8))}`);
    }

    await watchBatch(client, watchId, globalOpts);
  });

// ─── cancel ─────────────────────────────────────────────────────────────────

const cancelCmd = new Command('cancel')
  .description('Cancel a running batch')
  .argument('<id>', 'Batch ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Cancelling batch...', globalOpts.quiet);

    const { error } = await client.cancelBatch(id);

    if (error) {
      spinner.fail('Failed to cancel batch');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    spinner.stop(`Batch ${pc.cyan(id.slice(0, 8))} cancelled`);
  });

// ─── watch loop ─────────────────────────────────────────────────────────────

async function watchBatch(
  client: ValyuClient,
  id: string,
  globalOpts: GlobalOpts,
): Promise<void> {
  let polls = 0;
  const spinner = createSpinner('Waiting for batch to complete...', globalOpts.quiet);

  while (polls < MAX_POLLS) {
    const { data, error } = await client.getBatchStatus(id);

    if (error) {
      spinner.fail('Failed to fetch batch status');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const batch = data!;
    const status = String(batch.status ?? 'unknown');
    const completed = Number(batch.completed_tasks ?? batch.completed ?? 0);
    const total = Number(batch.total_tasks ?? batch.total ?? 0);
    const cost = batch.cost ?? batch.total_cost;

    if (status === 'completed') {
      const costStr = cost != null ? ` ${pc.dim('\u00B7')} $${Number(cost).toFixed(2)} total` : '';
      spinner.stop(`Batch complete: ${completed}/${total} tasks${costStr}`);
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(batch, { json: true });
      }
      return;
    }

    if (status === 'failed' || status === 'cancelled') {
      spinner.fail(`Batch ${status}`);
      outputError(
        {
          message: (batch.error as string) ?? `Batch ${status}`,
          code: `batch_${status}`,
        },
        { json: globalOpts.json },
      );
    }

    spinner.update(`Batch running... ${completed}/${total} tasks complete`);

    await new Promise((r) => setTimeout(r, POLL_MS));
    polls++;
  }

  spinner.fail('Timed out waiting for batch');
  outputError(
    { message: `Use 'valyu batch status ${id}' to check later.`, code: 'timeout' },
    { json: globalOpts.json },
  );
}

// ─── export ─────────────────────────────────────────────────────────────────

export const batchCommand = new Command('batch')
  .description('Run multiple deep research tasks in parallel')
  .addCommand(createCmd)
  .addCommand(listCmd)
  .addCommand(statusCmd)
  .addCommand(tasksCmd)
  .addCommand(addCmd)
  .addCommand(watchCmd)
  .addCommand(cancelCmd);
