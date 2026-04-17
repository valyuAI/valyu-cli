import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { relTime, colorStatus } from '../../lib/format.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseSourceBiases } from '../../lib/parsers.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

function parseMetadata(pairs: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of pairs) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid --metadata '${kv}'. Expected format: key=value`);
    const key = kv.slice(0, eq).trim();
    const raw = kv.slice(eq + 1);
    if (!key) throw new Error(`Invalid --metadata '${kv}'. Empty key.`);
    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

const MODES = ['fast', 'standard', 'heavy', 'max'] as const;
type Mode = (typeof MODES)[number];

const POLL_MS = 5000;
const MAX_POLLS = 1080;

function batchId(b: Record<string, unknown>): string {
  return String(b.batch_id ?? b.id ?? '');
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
  .argument('[queries...]', 'Research queries (added to the batch immediately)')
  .option('--name <name>', 'Human-readable name for the batch')
  .option('-m, --mode <mode>', `Research depth: ${MODES.join(', ')} (default: standard)`, 'standard')
  .option('--no-pdf', 'Skip PDF generation')
  .option('--output-format <fmt>', 'Output format (repeatable): markdown, toon (pdf is not available on batches)', collect, [] as string[])
  // Search config (advanced - shared across every task in the batch)
  .option('--search-type <type>', '[advanced] Search scope: all, web, proprietary')
  .option('--include-source <source>', '[advanced] Source to include (repeatable)', collect, [] as string[])
  .option('--exclude-source <source>', '[advanced] Source to exclude (repeatable)', collect, [] as string[])
  .option('--source-bias <kv>', '[advanced] Bias a source (repeatable). Format: <source>=<int> where int is -5..+5', collect, [] as string[])
  .option('--country <code>', '[advanced] ISO 3166-1 alpha-2 country code')
  .option('--start-date <date>', '[advanced] Earliest publication date (YYYY-MM-DD)')
  .option('--end-date <date>', '[advanced] Latest publication date (YYYY-MM-DD)')
  // Notifications
  .option('--webhook-url <url>', 'HTTPS URL to receive completion webhook (HMAC-signed)')
  .option('--alert-email <email>', 'Email to notify on completion (must belong to your organization)')
  .option('--alert-email-url <url>', 'Custom report link for the alert email. Must include {id} placeholder')
  // MCP + metadata
  .option('--mcp-config <path>', 'JSON file describing MCP servers to expose to every task (array, max 5)')
  .option('--metadata <kv>', 'Metadata attached to the batch (repeatable, key=value)', collect, [] as string[])
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu batch create "CRISPR gene therapy" "AI chip market" "Quantum computing"')}
  ${pc.dim('$ valyu batch create "Tesla" "Apple" --name "Q4-earnings" --mode heavy')}
  ${pc.dim('$ valyu batch create --webhook-url https://app.com/hook')}
  ${pc.dim('    "Company A DD brief" "Company B DD brief" \\\\')}
  ${pc.dim('    --metadata project=q4-diligence')}
`,
  )
  .action(async (queries, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    // Stdin fallback when no positional args provided
    // Queries are optional - an empty batch is valid (add tasks later with `batch add`).
    // Still read stdin in case queries are piped in.
    if (!queries || queries.length === 0) {
      const stdinData = await readStdin();
      if (stdinData) {
        queries = stdinData.split('\n').map((q) => q.trim()).filter(Boolean);
      }
      queries = queries ?? [];
    }

    if (!MODES.includes(opts.mode as Mode)) {
      outputError(
        {
          message: `Invalid mode '${opts.mode}'. Must be one of: ${MODES.join(', ')}`,
          code: 'invalid_mode',
        },
        { json: globalOpts.json },
      );
      return;
    }

    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    // Output formats: batches don't support pdf. Default to markdown.
    let outputFormats: string[];
    if (opts.outputFormat.length > 0) {
      for (const f of opts.outputFormat) {
        if (f !== 'markdown' && f !== 'toon') {
          fail(`Invalid --output-format '${f}'. Batches support: markdown, toon`, 'invalid_option');
          return;
        }
      }
      outputFormats = Array.from(new Set(opts.outputFormat));
    } else {
      outputFormats = ['markdown'];
    }

    // Source biases
    let sourceBiases: Record<string, number> | undefined;
    if (opts.sourceBias.length > 0) {
      try {
        sourceBiases = parseSourceBiases(opts.sourceBias);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Invalid --source-bias', 'invalid_option');
        return;
      }
    }

    // Shared search config
    const hasSearchOpts =
      opts.searchType ||
      opts.includeSource.length > 0 ||
      opts.excludeSource.length > 0 ||
      (sourceBiases && Object.keys(sourceBiases).length > 0) ||
      opts.country ||
      opts.startDate ||
      opts.endDate;
    const searchConfig = hasSearchOpts
      ? {
          searchType: opts.searchType,
          includedSources: opts.includeSource.length > 0 ? opts.includeSource : undefined,
          excludedSources: opts.excludeSource.length > 0 ? opts.excludeSource : undefined,
          sourceBiases,
          countryCode: opts.country,
          startDate: opts.startDate,
          endDate: opts.endDate,
        }
      : undefined;

    // Metadata
    let metadata: Record<string, string | number | boolean> | undefined;
    if (opts.metadata.length > 0) {
      try {
        metadata = parseMetadata(opts.metadata);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Invalid metadata', 'invalid_option');
        return;
      }
    }

    // MCP servers
    let mcpServers: Array<Record<string, unknown>> | undefined;
    if (opts.mcpConfig) {
      try {
        const loaded = JSON.parse(readFileSync(resolve(opts.mcpConfig), 'utf-8')) as unknown;
        if (!Array.isArray(loaded)) {
          fail('--mcp-config file must contain a JSON array', 'invalid_option');
          return;
        }
        mcpServers = loaded as Array<Record<string, unknown>>;
      } catch (err) {
        fail(
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `File not found: ${opts.mcpConfig}`
            : `Invalid JSON in ${opts.mcpConfig}`,
          'invalid_option',
        );
        return;
      }
    }

    const alertEmailValue: string | { email: string; custom_url?: string } | undefined = opts.alertEmail
      ? opts.alertEmailUrl
        ? { email: opts.alertEmail, custom_url: opts.alertEmailUrl }
        : opts.alertEmail
      : undefined;

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(
      queries.length > 0 ? `Creating batch with ${queries.length} queries...` : 'Creating batch...',
      globalOpts.quiet,
    );

    const { data, error } = await client.createBatch({
      name: opts.name,
      mode: opts.mode,
      outputFormats,
      search: searchConfig,
      webhookUrl: opts.webhookUrl,
      alertEmail: alertEmailValue,
      mcpServers,
      metadata,
    });

    if (error) {
      spinner.fail('Failed to create batch');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const batch = data! as Record<string, unknown>;
    const id = batchId(batch);

    // If queries were provided positionally, add them as tasks immediately
    if (queries.length > 0) {
      spinner.update(`Adding ${queries.length} task${queries.length === 1 ? '' : 's'}...`);
      const { error: addErr } = await client.addBatchTasks(
        id,
        queries.map((q) => ({ query: q })),
      );
      if (addErr) {
        spinner.fail('Batch created but tasks failed to add');
        outputError(
          { message: addErr.message, code: addErr.code ?? 'add_failed' },
          { json: globalOpts.json },
        );
        return;
      }
    }

    spinner.stop(`Batch created: ${pc.cyan(id)}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(batch, { json: true });
      return;
    }

    console.log('');
    console.log(`  ${pc.bold('Batch ID:')}  ${pc.cyan(id)}`);
    console.log(`  ${pc.bold('Mode:')}      ${batch.mode ?? opts.mode}`);
    console.log(`  ${pc.bold('Tasks:')}     ${queries.length}`);
    console.log(`  ${pc.bold('Output:')}    ${outputFormats.join(', ')}`);
    if (opts.name) console.log(`  ${pc.bold('Name:')}      ${opts.name}`);
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
  .option('-n, --limit <number>', 'Max batches to return')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const limit = opts.limit ? Number(opts.limit) : undefined;
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
      outputError(
        { message: '--limit must be a positive integer', code: 'invalid_option' },
        { json: globalOpts.json },
      );
      return;
    }
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading batches...', globalOpts.quiet);

    const { data, error } = await client.listBatches(limit);

    if (error) {
      spinner.fail('Failed to list batches');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
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
      return;
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

const BATCH_TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

const tasksCmd = new Command('tasks')
  .description('List individual tasks in a batch')
  .argument('<id>', 'Batch ID')
  .option('--status <status>', `Filter by status: ${BATCH_TASK_STATUSES.join(', ')}`)
  .option('-n, --limit <number>', 'Max tasks to return')
  .option('--last-key <cursor>', 'Pagination cursor from a previous response')
  .option('--include-output', 'Include output, sources, cost, and deliverables for each task')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (
      opts.status &&
      !BATCH_TASK_STATUSES.includes(opts.status as (typeof BATCH_TASK_STATUSES)[number])
    ) {
      fail(`Invalid --status '${opts.status}'. Valid: ${BATCH_TASK_STATUSES.join(', ')}`, 'invalid_option');
      return;
    }
    const limit = opts.limit ? Number(opts.limit) : undefined;
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
      fail('--limit must be a positive integer', 'invalid_option');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading batch tasks...', globalOpts.quiet);

    const { data, error } = await client.listBatchTasks(id, {
      status: opts.status,
      limit,
      lastKey: opts.lastKey,
      includeOutput: opts.includeOutput,
    });

    if (error) {
      spinner.fail('Failed to list batch tasks');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    // The server may return {tasks, pagination} OR a bare array (legacy).
    const body = data as Record<string, unknown> | null;
    const tasks: Record<string, unknown>[] = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : ((body?.tasks as Record<string, unknown>[]) ?? (body?.data as Record<string, unknown>[]) ?? []);
    const pagination = (body as Record<string, unknown>)?.pagination as
      | { count?: number; last_key?: string | null; has_more?: boolean }
      | undefined;
    spinner.stop(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      // Preserve pagination metadata for scripts
      outputResult(body ?? { tasks }, { json: true });
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
    if (pagination?.has_more && pagination.last_key) {
      console.log(
        `  ${pc.dim(`More tasks available. Next page: valyu batch tasks ${id.slice(0, 8)} --last-key ${pagination.last_key}`)}\n`,
      );
    }
  });

// ─── add ────────────────────────────────────────────────────────────────────

const addCmd = new Command('add')
  .description('Add tasks to an existing batch')
  .argument('<id>', 'Batch ID')
  .argument('[queries...]', 'Research queries (simple form; each becomes a task with just `query`)')
  .option(
    '--tasks-file <path>',
    'JSON file with a tasks array. Each item: {query, id?, research_strategy?, report_format?, urls?, metadata?}. Use this for rich per-task config',
  )
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu batch add <id> "Tesla analysis" "Apple analysis"')}
  ${pc.dim('$ valyu batch add <id> --tasks-file tasks.json')}

${pc.dim('tasks.json:')}

  ${pc.dim('[')}
  ${pc.dim('  { "id": "tesla", "query": "TSLA Q4 analysis",')}
  ${pc.dim('    "research_strategy": "focus on guidance and FSD progress",')}
  ${pc.dim('    "report_format": "2-page analyst brief" },')}
  ${pc.dim('  { "id": "apple",  "query": "AAPL Q4 analysis",')}
  ${pc.dim('    "urls": ["https://investor.apple.com/..."] }')}
  ${pc.dim(']')}
`,
  )
  .action(async (id, queries, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    let tasks: Array<Record<string, unknown>>;
    if (opts.tasksFile) {
      try {
        const loaded = JSON.parse(readFileSync(resolve(opts.tasksFile), 'utf-8')) as unknown;
        if (!Array.isArray(loaded)) {
          fail('--tasks-file must contain a JSON array', 'invalid_option');
          return;
        }
        tasks = loaded as Array<Record<string, unknown>>;
        if (queries.length > 0) {
          tasks.push(...queries.map((q) => ({ query: q })));
        }
      } catch (err) {
        fail(
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `File not found: ${opts.tasksFile}`
            : `Invalid JSON in ${opts.tasksFile}`,
          'invalid_option',
        );
        return;
      }
    } else if (queries.length > 0) {
      tasks = queries.map((q) => ({ query: q }));
    } else {
      fail('No tasks provided. Pass queries positionally or use --tasks-file <path>.', 'missing_tasks');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(
      `Adding ${tasks.length} task${tasks.length === 1 ? '' : 's'} to batch...`,
      globalOpts.quiet,
    );

    const { data, error } = await client.addBatchTasks(id, tasks);

    if (error) {
      spinner.fail('Failed to add tasks');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(
      `Added ${tasks.length} task${tasks.length === 1 ? '' : 's'} to batch ${pc.cyan(id.slice(0, 8))}`,
    );

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
        return;
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
      return;
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
      return;
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
      return;
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
