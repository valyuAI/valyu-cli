import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command, Option } from '@commander-js/extra-typings';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import type { GlobalOpts } from '../../lib/client.js';
import {
  ValyuClient,
  PLATFORM_URL,
  requireApiKey,
  type ResearchStatus,
  type ResearchListItem,
  type ResearchListResult,
} from '../../lib/client.js';
import { relTime, colorStatus } from '../../lib/format.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseCountry, parseDate, parseIntOption, parseKeyValues, parseSourceBiases } from '../../lib/parsers.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';
import { isInteractive } from '../../lib/tty.js';

const MODES = ['fast', 'standard', 'heavy', 'max'] as const;
type Mode = (typeof MODES)[number];

const MODE_INFO: Record<Mode, { price: string; eta: string; use: string }> = {
  fast: { price: '$0.10', eta: '~8-12 min', use: 'a focused, cited answer (default)' },
  standard: { price: '$0.50', eta: '~10-20 min', use: 'a broader sweep, more sources' },
  heavy: { price: '$2.50', eta: 'up to ~90 min', use: 'a deep multi-angle investigation' },
  max: { price: '$15.00', eta: 'up to ~3 hours', use: 'exhaustive - only when explicitly asked' },
};

const POLL_MS = 5000;
// Long enough for the slowest mode, with headroom.
const MAX_POLLS = (4 * 60 * 60 * 1000) / POLL_MS;
const MAX_TRANSIENT_FAILURES = 5;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// States a task will not leave on its own: finished, or paused at a checkpoint.
const SETTLED = new Set([...TERMINAL, 'awaiting_input', 'paused']);

/** Checkpoint types and the `respond --response` payload each expects. */
const RESPONSE_SHAPES: Record<string, string> = {
  planning_questions: '{"answers": [{"question": "<question>", "answer": "<answer>"}]}',
  plan_review: '{"approved": true} or {"approved": false, "modifications": "<what to change>"}',
  source_review: '{"included_domains": [...], "excluded_domains": [...]} (both [] accepts the recommendations)',
  outline_review: '{"approved": true} or {"approved": false, "modifications": "<what to change>"}',
};

/**
 * The status payload carries the agent's whole transcript (`messages`, tens
 * of KB and growing on every poll). Nothing reads it, so it is dropped before
 * anything is printed.
 */
function withoutTranscript(status: ResearchStatus): ResearchStatus {
  const { messages: _messages, ...rest } = status;
  return rest;
}

function taskId(t: { deepresearch_id?: unknown; id?: unknown; task_id?: unknown }): string {
  return String(t.deepresearch_id ?? t.id ?? t.task_id ?? '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SEPARATOR = pc.dim('  ' + '\u2500'.repeat(40));

const SEARCH_TYPES = ['all', 'web', 'proprietary'] as const;
const HITL_CHECKPOINTS = {
  'planning-questions': 'planning_questions',
  'plan-review': 'plan_review',
  'source-review': 'source_review',
  'outline-review': 'outline_review',
} as const;

const collect = (value: string, prev: string[] = []): string[] => [...prev, value];

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function loadFileAttachment(filePath: string): { data: string; filename: string; mediaType: string } {
  const abs = resolve(filePath);
  const buf = readFileSync(abs);
  const ext = extname(abs).toLowerCase();
  const mediaType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const data = `data:${mediaType};base64,${buf.toString('base64')}`;
  return { data, filename: basename(abs), mediaType };
}

function parseHitl(value: string): Record<string, boolean> {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  const out: Record<string, boolean> = {};
  for (const p of parts) {
    const key = HITL_CHECKPOINTS[p as keyof typeof HITL_CHECKPOINTS];
    if (!key) {
      throw new Error(
        `Invalid --hitl checkpoint '${p}'. Valid: ${Object.keys(HITL_CHECKPOINTS).join(', ')}`,
      );
    }
    out[key] = true;
  }
  return out;
}

function readJsonFile<T>(filePath: string, label: string): T {
  try {
    const raw = readFileSync(resolve(filePath), 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw new Error(`Invalid JSON in ${label} file ${filePath}: ${err instanceof Error ? err.message : 'parse error'}`);
  }
}

// ─── create ─────────────────────────────────────────────────────────────────

const createCmd = new Command('create')
  .description('Start an asynchronous deep research task that writes a thorough, cited report')
  .argument('[query]', 'The research brief (or pipe it in). Not needed with --workflow')
  .option('-m, --mode <mode>', `Depth and cost: ${MODES.join(', ')}`, 'fast')
  .option('-w, --watch', 'Wait for completion and print the report')
  // Steering
  .option('--report-format <text>', 'How to structure the report, e.g. "one-page memo with a risks table"')
  .option('--research-strategy <text>', 'How to run the research, e.g. "prioritise primary sources"')
  // Output
  .option('--pdf', 'Also produce a PDF of the report')
  .addOption(new Option('--no-pdf', 'No PDF (the default)').hideHelp())
  .option('--structured <schema>', 'JSON schema for structured JSON output instead of a markdown report (inline JSON)')
  .option('--structured-file <path>', 'Same as --structured, read from a file')
  .option('--deliverable <desc>', 'A file to generate from the report, e.g. "XLSX of every trial with phase and sponsor" (repeatable, max 10)', collect, [] as string[])
  .option('--deliverables-file <path>', 'JSON array of deliverables: strings or {"type": "csv|xlsx|pptx|docx|pdf", "description": "...", "columns": [...]}')
  // Context
  .option('--url <url>', 'A URL the agent must read (repeatable, max 10)', collect, [] as string[])
  .option('--file <path>', 'A file for the agent to analyse, base64-encoded for you (repeatable, max 10)', collect, [] as string[])
  .option('--file-context <text>', 'What the Nth --file is and how to use it (repeatable, pairs with --file by position)', collect, [] as string[])
  .option('--previous-report <id>', 'An earlier task whose report becomes context (repeatable, max 3)', collect, [] as string[])
  // Agent tools and checkpoints
  .option('--code-execution', 'Enable sandboxed Python for analysis and tables')
  .option('--screenshots', 'Enable page screenshots')
  .option('--browser-use', 'Enable autonomous browser sessions for interactive sites')
  .option('--charts', 'Embed generated charts in the report')
  .option('--hitl <checkpoints>', `Pause for approval at: ${Object.keys(HITL_CHECKPOINTS).join(', ')} (comma-separated)`)
  .option('--mcp-config <path>', 'JSON array of MCP servers (max 5) whose tools the agent may call. A file keeps tokens out of shell history')
  // Notifications
  .option('--webhook-url <url>', 'HTTPS URL to POST to on completion (HMAC-SHA256 signed)')
  .option('--alert-email <email>', 'Email the finished report link here (must belong to your organisation)')
  .option('--metadata <kv>', 'key=value tag stored with the task (repeatable)', collect, [] as string[])
  // Workflows
  .option('--workflow <slug>', 'Run a saved research template instead of a free-form brief')
  .option('-P, --param <kv>', 'Template variable for --workflow, key=value (repeatable)', collect, [] as string[])
  .option('--workflow-version <n>', 'Pin a template version (default: current)')
  // Search config - ADVANCED. The agent routes across everything better than a
  // guessed scope does, and a wrong value silently starves the report.
  .option('--include-source <source>', '[advanced] Only research this source (repeatable): dataset id, domain, URL prefix, or "web"', collect, [] as string[])
  .option('--exclude-source <source>', '[advanced] Leave out this source (repeatable)', collect, [] as string[])
  .option('--source-bias <source=n>', '[advanced] Rank a domain up or down, -5..+5, without excluding anything (repeatable)', collect, [] as string[])
  .option('--search-type <type>', `[advanced] ${SEARCH_TYPES.join(', ')} (default all; the others cut the agent off from half the corpus)`)
  .option('--country <code>', '[advanced] Bias web results to a country (ISO 3166-1 alpha-2)')
  .option('--start-date <date>', '[advanced] Only sources published on or after this date (YYYY-MM-DD)')
  .option('--end-date <date>', '[advanced] Only sources published on or before this date (YYYY-MM-DD)')
  .addHelpText(
    'after',
    `
Deep research is an agent: it plans, searches the web and specialised
datasets, reads sources and writes a structured report with citations. Even
${pc.cyan('fast')} takes several minutes, so use it when deep research was asked for.
A request for "a report" or "some research" is usually better served by a few
${pc.cyan('valyu search')} calls - seconds, not minutes.

It is asynchronous: ${pc.cyan('create')} returns a task id at once. Check back with
${pc.cyan('valyu deepresearch status <id>')} (the finished report comes back in full), or
block with ${pc.cyan('--watch')} / ${pc.cyan('valyu deepresearch watch <id>')}.

${pc.dim('Modes:')}

${MODES.map((m) => `  ${pc.cyan(m.padEnd(10))} ${MODE_INFO[m].eta.padEnd(15)} ${MODE_INFO[m].price.padEnd(7)} ${MODE_INFO[m].use}`).join('\n')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu deepresearch create "NVDA Q4 earnings: guidance, datacenter segment, margin trajectory" --watch')}
  ${pc.dim('$ valyu deepresearch create "Clinical-stage oral GLP-1 agonists in obesity" -m standard \\\\')}
  ${pc.dim('    --deliverable "XLSX: molecule, developer, mechanism, phase, NCT ID"')}
  ${pc.dim('$ valyu deepresearch create "Enterprise AI coding assistants landscape" -m heavy --hitl plan-review --pdf')}
  ${pc.dim('$ valyu deepresearch create --workflow ib-company-profile -P company="NVIDIA (NVDA)"')}
`,
  )
  .action(async (query, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string): never => outputError({ message, code }, { json: globalOpts.json });

    if (!opts.workflow && !query) query = (await readStdin()) ?? undefined;
    if (!opts.workflow && !query?.trim()) {
      return fail(
        'Provide the research brief, or --workflow <slug>.\n\n  Usage: valyu deepresearch create "your brief"\n         echo "your brief" | valyu deepresearch create',
        'missing_query',
      );
    }
    if (!MODES.includes(opts.mode as Mode)) {
      return fail(`Invalid mode '${opts.mode}'. Must be one of: ${MODES.join(', ')}`, 'invalid_mode');
    }
    if (opts.searchType && !SEARCH_TYPES.includes(opts.searchType as (typeof SEARCH_TYPES)[number])) {
      return fail(`Invalid --search-type '${opts.searchType}'. Valid: ${SEARCH_TYPES.join(', ')}`, 'invalid_option');
    }
    if (opts.structured && opts.structuredFile) return fail('Use --structured or --structured-file, not both', 'invalid_options');
    if ((opts.structured || opts.structuredFile) && opts.pdf) {
      return fail('Structured JSON output cannot be combined with --pdf; choose one.', 'invalid_options');
    }
    if (opts.fileContext.length > opts.file.length) {
      return fail('More --file-context entries than --file entries. Each --file-context pairs with a --file by position.', 'invalid_options');
    }
    if (opts.url.length > 10 || opts.file.length > 10) return fail('At most 10 --url and 10 --file entries.', 'invalid_options');
    if (opts.previousReport.length > 3) return fail('At most 3 --previous-report entries.', 'invalid_options');
    if (opts.param.length && !opts.workflow) return fail('--param needs --workflow', 'invalid_options');

    let structuredSchema: Record<string, unknown> | undefined;
    let files: Array<{ data: string; filename: string; mediaType: string; context?: string }> | undefined;
    let deliverables: Array<string | Record<string, unknown>> | undefined;
    let mcpServers: Array<Record<string, unknown>> | undefined;
    let search: Parameters<ValyuClient['createResearch']>[0]['search'];
    let metadata: Record<string, string | number | boolean> | undefined;
    let workflowParams: Record<string, unknown> | undefined;
    let workflowVersion: number | undefined;
    let hitl: Record<string, boolean> | undefined;
    try {
      if (opts.structuredFile) structuredSchema = readJsonFile<Record<string, unknown>>(opts.structuredFile, 'schema');
      else if (opts.structured) {
        try {
          structuredSchema = JSON.parse(opts.structured);
        } catch {
          throw new Error('Invalid JSON for --structured. Tip: use --structured-file to read it from a file.');
        }
      }
      files = opts.file.length
        ? opts.file.map((path, i) => {
            const attachment = loadFileAttachment(path);
            return opts.fileContext[i] ? { ...attachment, context: opts.fileContext[i] } : attachment;
          })
        : undefined;
      if (opts.deliverable.length || opts.deliverablesFile) {
        const fromFile = opts.deliverablesFile ? readJsonFile<unknown>(opts.deliverablesFile, 'deliverables') : [];
        if (!Array.isArray(fromFile)) throw new Error('--deliverables-file must contain a JSON array');
        deliverables = [...opts.deliverable, ...(fromFile as Array<string | Record<string, unknown>>)];
      }
      if (opts.mcpConfig) {
        const loaded = readJsonFile<unknown>(opts.mcpConfig, 'mcp');
        if (!Array.isArray(loaded)) throw new Error('--mcp-config file must contain a JSON array');
        mcpServers = loaded as Array<Record<string, unknown>>;
      }
      metadata = opts.metadata.length ? parseKeyValues(opts.metadata, '--metadata') : undefined;
      workflowParams = opts.param.length ? parseKeyValues(opts.param, '--param') : undefined;
      workflowVersion = opts.workflowVersion ? parseIntOption(opts.workflowVersion, '--workflow-version', 1, 1_000_000) : undefined;
      hitl = opts.hitl ? parseHitl(opts.hitl) : undefined;
      search = {
        searchType: opts.searchType,
        includedSources: opts.includeSource.length ? opts.includeSource : undefined,
        excludedSources: opts.excludeSource.length ? opts.excludeSource : undefined,
        sourceBiases: opts.sourceBias.length ? parseSourceBiases(opts.sourceBias) : undefined,
        countryCode: parseCountry(opts.country),
        startDate: parseDate(opts.startDate, '--start-date'),
        endDate: parseDate(opts.endDate, '--end-date'),
      };
    } catch (err) {
      return fail((err as Error).message, 'invalid_option');
    }

    // A template carries its own recommended mode, so only send one the caller chose.
    const modeChosen = cmd.getOptionValueSource('mode') !== 'default';
    const mode = opts.workflow && !modeChosen ? undefined : (opts.mode as Mode);
    let outputFormats: Array<string | Record<string, unknown>> | undefined;
    if (structuredSchema) outputFormats = [structuredSchema];
    else if (opts.pdf) outputFormats = ['markdown', 'pdf'];
    const tools =
      opts.codeExecution || opts.screenshots || opts.browserUse || opts.charts
        ? {
            code_execution: opts.codeExecution || undefined,
            screenshots: opts.screenshots || undefined,
            browser_use: opts.browserUse || undefined,
            charts: opts.charts || undefined,
          }
        : undefined;

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Starting deep research...', globalOpts.quiet);

    const { data, error } = await client.createResearch({
      query: opts.workflow ? undefined : query?.trim(),
      workflowId: opts.workflow,
      workflowParams,
      workflowVersion,
      mode,
      outputFormats,
      researchStrategy: opts.researchStrategy,
      reportFormat: opts.reportFormat,
      search,
      urls: opts.url.length ? opts.url : undefined,
      files,
      metadata,
      tools,
      mcpServers,
      previousReports: opts.previousReport.length ? opts.previousReport : undefined,
      webhookUrl: opts.webhookUrl,
      alertEmail: opts.alertEmail,
      deliverables,
      hitl,
    });

    if (error) {
      spinner.fail('Failed to start deep research');
      return fail(error.message, error.code ?? 'research_failed');
    }

    const task = data!;
    const id = taskId(task);
    if (!id) {
      spinner.fail('No task id returned');
      return fail('Deep research was accepted but no task id came back. Retry; if it persists, this is an API issue.', 'unexpected_response');
    }
    spinner.stop(`Deep research started: ${pc.cyan(id)}`);

    if (opts.watch) {
      await watchResearch(client, id, globalOpts);
      return;
    }
    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(task, { json: true });
      return;
    }

    const shownMode = task.mode ?? mode ?? 'template default';
    const info = MODE_INFO[shownMode as Mode];
    console.log('');
    console.log(`  ${pc.bold('Task ID:')}  ${pc.cyan(id)}`);
    console.log(`  ${pc.bold('Mode:')}     ${shownMode}${info ? pc.dim(`  (${info.price}, ${info.eta})`) : ''}`);
    console.log(`  ${pc.bold('Status:')}   ${colorStatus(task.status ?? 'queued')}`);
    if (hitl) console.log(`  ${pc.bold('HITL:')}     ${Object.keys(hitl).join(', ')}`);
    if (deliverables?.length) console.log(`  ${pc.bold('Deliverables:')} ${deliverables.length}`);
    console.log('');
    console.log(`  ${pc.dim('It runs in the background. Check back with:')} valyu deepresearch status ${id}`);
    console.log(`  ${pc.dim('Or wait for it:')}                        valyu deepresearch watch ${id}`);
    console.log('');
  });

// ─── list / status ──────────────────────────────────────────────────────────

async function listTasks(client: ValyuClient, limit: number, globalOpts: GlobalOpts): Promise<void> {
  const spinner = createSpinner('Loading tasks...', globalOpts.quiet);
  const { data, error } = await client.listResearch(limit);
  if (error) {
    spinner.fail('Failed to list tasks');
    return outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
  }

  const raw = data as ResearchListResult;
  const tasks: ResearchListItem[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
  spinner.stop(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);

  if (globalOpts.json || !process.stdout.isTTY) {
    outputResult(tasks, { json: true });
    return;
  }
  if (tasks.length === 0) {
    console.log(`\n  ${pc.dim('No research tasks yet. Start one with:')} valyu deepresearch create "your brief"\n`);
    return;
  }

  console.log('');
  for (const t of tasks) {
    const label = t.title ?? t.query;
    const q = label.length > 60 ? label.slice(0, 57) + '...' : label;
    console.log(`  ${pc.cyan(t.deepresearch_id)}`);
    console.log(`  ${colorStatus(t.status)}  ${pc.dim(relTime(t.created_at))}  ${q}`);
    console.log('');
  }
  console.log(`  ${pc.dim('Read a report:')} valyu deepresearch status <id>\n`);
}

const listCmd = new Command('list')
  .description('List recent research tasks, newest first')
  .option('-n, --limit <n>', 'Max results (1-50)', '20')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    let limit: number;
    try {
      limit = parseIntOption(opts.limit, '--limit', 1, 50);
    } catch (err) {
      return outputError({ message: (err as Error).message, code: 'invalid_option' }, { json: globalOpts.json });
    }
    const resolved = requireApiKey(globalOpts);
    await listTasks(new ValyuClient(resolved.key), limit, globalOpts);
  });

const statusCmd = new Command('status')
  .description('Check a task - the full report once it completes. Without an id, list recent tasks')
  .argument('[id]', 'Research task ID (omit to list recent tasks)')
  .option('--wait <seconds>', 'Block up to this long (max 3600) for the task to finish before answering')
  .option('-n, --limit <n>', 'When listing: max results (1-50)', '20')
  .addHelpText(
    'after',
    `
Instant by default: while the task runs this is a short status line, and once
it completes it is the finished report with citations. A paused task shows
its checkpoint and the ${pc.cyan('respond')} payload it expects.

Checking again straight away returns the same line. To wait, use ${pc.cyan('--wait')}
(bounded) or ${pc.cyan('valyu deepresearch watch <id>')} (until done) - never loop status.
`,
  )
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string): never => outputError({ message, code }, { json: globalOpts.json });
    let waitMs: number;
    let limit: number;
    try {
      waitMs = opts.wait ? parseIntOption(opts.wait, '--wait', 0, 3600) * 1000 : 0;
      limit = parseIntOption(opts.limit, '--limit', 1, 50);
    } catch (err) {
      return fail((err as Error).message, 'invalid_option');
    }
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    if (!id) return listTasks(client, limit, globalOpts);

    const spinner = createSpinner('Fetching status...', globalOpts.quiet);
    const deadline = Date.now() + waitMs;
    let { data, error } = await client.getResearchStatus(id);
    while (data && !SETTLED.has(data.status) && Date.now() + POLL_MS < deadline) {
      spinner.update(progressLine(data));
      await sleep(POLL_MS);
      ({ data, error } = await client.getResearchStatus(id));
    }
    if (error || !data) {
      spinner.fail('Failed to fetch status');
      return fail(error?.message ?? 'Empty status response', error?.code ?? 'status_failed');
    }

    const status = withoutTranscript(data);
    spinner.stop(`Status: ${colorStatus(status.status)}`);
    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(status, { json: true });
      return;
    }
    renderResearchStatus(status);
  });

// ─── watch ──────────────────────────────────────────────────────────────────

const watchCmd = new Command('watch')
  .description('Poll a research task until complete (omit ID to watch latest)')
  .argument('[id]', 'Research task ID (default: latest running task)')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    let watchId = id;

    if (!watchId) {
      const spinner = createSpinner('Finding latest task...', globalOpts.quiet);
      const { data, error } = await client.listResearch(20);
      if (error) {
        spinner.fail('Failed to list tasks');
        outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
        return;
      }
      const rawList = data as ResearchListResult;
      const allTasks: ResearchListItem[] = Array.isArray(rawList) ? rawList : (rawList?.data ?? []);
      const running = allTasks.find(
        (t: ResearchListItem) => t.status === 'running' || t.status === 'queued' || t.status === 'awaiting_input',
      );
      if (!running) {
        spinner.fail('No running research tasks found');
        outputError(
          { message: 'No running tasks. Create one with: valyu deepresearch create "query"', code: 'no_tasks' },
          { json: globalOpts.json },
        );
        return;
      }
      watchId = running.deepresearch_id;
      spinner.stop(`Watching: ${pc.cyan(watchId.slice(0, 8))} - ${running.query.slice(0, 50)}`);
    }

    await watchResearch(client, watchId, globalOpts);
  });

// ─── cancel ─────────────────────────────────────────────────────────────────

const cancelCmd = new Command('cancel')
  .description('Stop a running task (billing stops at the work already done)')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Cancelling task...', globalOpts.quiet);

    const { data, error } = await client.cancelResearch(id);

    if (error) {
      spinner.fail('Failed to cancel task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} cancelled`);
    if (globalOpts.json || !process.stdout.isTTY) outputResult(data ?? { success: true }, { json: true });
  });

// ─── steer ──────────────────────────────────────────────────────────────────

const steerCmd = new Command('steer')
  .alias('update')
  .description('Redirect or narrow a running task with a follow-up instruction')
  .argument('<id>', 'Research task ID')
  .argument('<instruction>', 'The instruction in plain language (pass "-" to read it from stdin)')
  .addHelpText(
    'after',
    `
${pc.dim('Applied to the remaining steps; accepted until the writing phase begins.')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu deepresearch steer <id> "Also cover EU regulation"')}
  ${pc.dim('$ valyu deepresearch steer <id> "Ignore sources before 2024"')}
  ${pc.dim('$ echo "Add a pricing comparison table" | valyu deepresearch steer <id> -')}
`,
  )
  .action(async (id, instruction, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    if (instruction === '-') instruction = (await readStdin()) ?? '';
    if (!instruction.trim()) {
      return outputError({ message: 'No instruction provided', code: 'missing_instruction' }, { json: globalOpts.json });
    }
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Sending instruction...', globalOpts.quiet);

    const { data, error } = await client.updateResearch(id, instruction.trim());
    if (error) {
      spinner.fail('Failed to steer task');
      return outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }
    spinner.stop(`Instruction sent to task ${pc.cyan(id.slice(0, 8))}`);
    if (globalOpts.json || !process.stdout.isTTY) outputResult(data ?? { success: true }, { json: true });
  });

// ─── respond (HITL) ─────────────────────────────────────────────────────────

const respondCmd = new Command('respond')
  .description('Respond to a HITL checkpoint on a paused research task (programmatic, non-interactive)')
  .argument('<id>', 'Research task ID')
  .option('--interaction-id <id>', 'Specific interaction_id. If omitted, uses the task\'s current pending interaction')
  .option('--response <json>', 'Response payload as JSON string')
  .option('--response-file <path>', 'Response payload as JSON file path')
  .option('--approve', 'Shorthand for plan_review / outline_review: {"approved": true}')
  .option('--reject', 'Shorthand for plan_review / outline_review: {"approved": false}')
  .option('--modifications <text>', 'With --reject: {"approved": false, "modifications": "<text>"}')
  .addHelpText(
    'after',
    `
${pc.dim('Each HITL checkpoint type expects a specific response shape:')}

  ${pc.dim('planning_questions:   {"answers":[{"question":"...","answer":"..."}, ...]}')}
  ${pc.dim('plan_review:          {"approved": true} | {"approved": false, "modifications": "..."}')}
  ${pc.dim('source_review:        {"included_domains":[...], "excluded_domains":[...]}')}
  ${pc.dim('outline_review:       {"approved": true} | {"approved": false, "modifications": "..."}')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu deepresearch respond <id> --approve')}
  ${pc.dim('$ valyu deepresearch respond <id> --reject --modifications "Focus more on EU regulators"')}
  ${pc.dim('$ valyu deepresearch respond <id> --response-file response.json')}
  ${pc.dim('$ echo \'{"included_domains":["sec.gov"],"excluded_domains":[]}\' \\')}
  ${pc.dim('    | valyu deepresearch respond <id> --response -')}
`,
  )
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    // Build response payload from the various option forms
    let responsePayload: Record<string, unknown> | undefined;
    const explicit = [opts.response, opts.responseFile, opts.approve, opts.reject].filter(Boolean).length;
    if (opts.approve && opts.reject) {
      fail('Use either --approve or --reject, not both', 'invalid_options');
      return;
    }
    if (explicit === 0) {
      fail(
        'Provide a response: --approve, --reject [--modifications <text>], --response <json>, or --response-file <path>',
        'missing_response',
      );
      return;
    }

    if (opts.approve) {
      responsePayload = { approved: true };
    } else if (opts.reject) {
      responsePayload = opts.modifications
        ? { approved: false, modifications: opts.modifications }
        : { approved: false };
    } else if (opts.responseFile) {
      try {
        responsePayload = JSON.parse(readFileSync(resolve(opts.responseFile), 'utf-8'));
      } catch (err) {
        fail(
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `File not found: ${opts.responseFile}`
            : `Invalid JSON in ${opts.responseFile}`,
          'invalid_response',
        );
        return;
      }
    } else if (opts.response) {
      let raw = opts.response;
      if (raw === '-') {
        const piped = await readStdin();
        if (!piped) {
          fail('No response provided on stdin', 'missing_response');
          return;
        }
        raw = piped.trim();
      }
      try {
        responsePayload = JSON.parse(raw);
      } catch {
        fail('Invalid JSON for --response. Tip: use --response-file to read from a file.', 'invalid_response');
        return;
      }
    }
    if (!responsePayload || typeof responsePayload !== 'object') {
      fail('Response must be a JSON object', 'invalid_response');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    // Resolve interaction_id: use the provided one, or look it up from the task.
    let interactionId = opts.interactionId;
    if (!interactionId) {
      const { data: status, error: statusErr } = await client.getResearchStatus(id);
      if (statusErr) {
        fail(statusErr.message, statusErr.code ?? 'status_failed');
        return;
      }
      interactionId = status?.interaction?.interaction_id;
      if (!interactionId) {
        fail(
          `Task ${id} has no pending HITL interaction. Status: ${status?.status ?? 'unknown'}. Pass --interaction-id explicitly if you know it.`,
          'no_interaction',
        );
        return;
      }
    }

    const spinner = createSpinner('Sending HITL response...', globalOpts.quiet);
    const { data, error } = await client.respondResearch(id, interactionId, responsePayload);
    if (error) {
      spinner.fail('Respond failed');
      fail(error.message, error.code ?? 'respond_failed');
      return;
    }

    spinner.stop(`Response accepted for task ${pc.cyan(id.slice(0, 8))}`);
    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
    }
  });

// ─── delete ─────────────────────────────────────────────────────────────────

const deleteCmd = new Command('delete')
  .description('Permanently delete a finished task and its report')
  .argument('<id>', 'Research task ID')
  .option('-y, --yes', 'Skip confirmation prompt (required when not running interactively)')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    if (!opts.yes && !isInteractive()) {
      return outputError(
        { message: 'Deleting is irreversible. Confirm with the user, then pass --yes.', code: 'confirmation_required' },
        { json: globalOpts.json },
      );
    }
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    if (!opts.yes) {
      const confirm = await p.confirm({
        message: `Delete research task ${pc.cyan(id.slice(0, 8))}? This cannot be undone.`,
      });

      if (p.isCancel(confirm) || !confirm) {
        console.log(`  ${pc.dim('Cancelled')}`);
        return;
      }
    }

    const spinner = createSpinner('Deleting task...', globalOpts.quiet);

    const { data, error } = await client.deleteResearch(id);

    if (error) {
      spinner.fail('Failed to delete task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} deleted`);
    if (globalOpts.json || !process.stdout.isTTY) outputResult(data ?? { success: true }, { json: true });
  });

// ─── share ──────────────────────────────────────────────────────────────────

const shareCmd = new Command('share')
  .description('Publish a public link to a task\'s report (--off to make it private again)')
  .argument('<id>', 'Research task ID')
  .option('--off', 'Remove the public link')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const makePublic = !opts.off;
    const spinner = createSpinner(makePublic ? 'Publishing...' : 'Making private...', globalOpts.quiet);

    const { data, error } = await client.toggleResearchPublic(id, makePublic);
    if (error) {
      spinner.fail('Failed to change sharing');
      return outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const res = (data ?? {}) as { share_url?: string; url?: string };
    const url = makePublic ? (res.share_url ?? res.url ?? `${PLATFORM_URL}/playground/deepresearch/${id}`) : undefined;
    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} is ${makePublic ? pc.green('public') : pc.dim('private')}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult({ ...(data ?? {}), deepresearch_id: id, public: makePublic, ...(url ? { share_url: url } : {}) }, { json: true });
      return;
    }
    if (url) console.log(`\n  ${pc.bold('Public URL:')}  ${pc.cyan(url)}\n`);
  });

// ─── HITL interaction handlers ──────────────────────────────────────────────

interface InteractionQuestion {
  question: string;
  context?: string;
}

interface SourceDomain {
  domain: string;
  source_count: number;
  avg_relevance_score: number;
  ai_recommendation: string;
}

async function handlePlanningQuestions(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const questions = (data.questions ?? []) as InteractionQuestion[];

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold('Checkpoint: Planning Questions')}`);
  console.log(SEPARATOR);
  console.log('');
  console.log('  The agent has questions before proceeding:');
  console.log('');

  const answers: Array<{ question: string; answer: string }> = [];

  for (const q of questions) {
    if (q.context) {
      console.log(`  ${pc.dim(q.context)}`);
    }

    const answer = await p.text({
      message: q.question,
    });

    if (p.isCancel(answer)) {
      console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
      return false;
    }

    answers.push({ question: q.question, answer });
  }

  const { error } = await client.respondResearch(id, interactionId, { answers });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit responses: ${error.message}`);
    return false;
  }

  console.log(`  ${pc.green('\u2714')} Responses submitted`);
  return true;
}

async function handlePlanReview(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const plan = (data.plan ?? '') as string;
  const researchAreas = (data.research_areas ?? []) as string[];
  const estimatedSteps = (data.estimated_steps ?? 0) as number;

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold('Checkpoint: Plan Review')}`);
  console.log(SEPARATOR);
  console.log('');

  if (researchAreas.length > 0) {
    console.log(`  ${pc.bold('Research areas:')}`);
    for (const area of researchAreas) {
      console.log(`    ${pc.dim('\u00b7')} ${area}`);
    }
    console.log('');
  }

  if (estimatedSteps > 0) {
    console.log(`  ${pc.bold('Estimated steps:')} ${estimatedSteps}`);
    console.log('');
  }

  console.log(`  ${pc.bold('Plan:')}`);
  console.log('');
  for (const line of plan.split('\n')) {
    console.log(`  ${line}`);
  }
  console.log('');

  const approved = await p.confirm({
    message: 'Approve this research plan?',
  });

  if (p.isCancel(approved)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  if (approved) {
    const { error } = await client.respondResearch(id, interactionId, { approved: true });
    if (error) {
      console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
      return false;
    }
    console.log(`  ${pc.green('\u2714')} Plan approved`);
    return true;
  }

  const modifications = await p.text({
    message: 'What modifications would you like?',
  });

  if (p.isCancel(modifications)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  const { error } = await client.respondResearch(id, interactionId, {
    approved: false,
    modifications,
  });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
    return false;
  }

  console.log(`  ${pc.green('\u2714')} Modifications submitted`);
  return true;
}

async function handleSourceReview(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const domains = (data.domains ?? []) as SourceDomain[];
  const totalSources = domains.reduce((sum, d) => sum + d.source_count, 0);

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold(`Checkpoint: Source Review (${totalSources} sources found)`)}`);
  console.log(SEPARATOR);
  console.log('');

  // Table header
  const domainCol = 18;
  const sourcesCol = 9;
  const relCol = 11;
  const recCol = 10;

  console.log(
    `  ${pc.bold('Domain'.padEnd(domainCol))}${pc.bold('Sources'.padEnd(sourcesCol))}${pc.bold('Relevance'.padEnd(relCol))}${pc.bold('AI says'.padEnd(recCol))}`,
  );

  for (const d of domains) {
    const domainStr = d.domain.length > domainCol - 2 ? d.domain.slice(0, domainCol - 3) + '..' : d.domain;
    const relevance = `${Math.round(d.avg_relevance_score * 100)}%`;
    const recColor = d.ai_recommendation === 'include' ? pc.green : pc.red;
    console.log(
      `  ${domainStr.padEnd(domainCol)}${String(d.source_count).padEnd(sourcesCol)}${relevance.padEnd(relCol)}${recColor(d.ai_recommendation.padEnd(recCol))}`,
    );
  }

  console.log('');

  const excludeInput = await p.text({
    message: 'Domains to exclude (comma-separated, or Enter to accept AI recommendations)',
    defaultValue: '',
  });

  if (p.isCancel(excludeInput)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  const excluded = (excludeInput ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { error } = await client.respondResearch(id, interactionId, {
    included_domains: [],
    excluded_domains: excluded,
  });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
    return false;
  }

  if (excluded.length > 0) {
    console.log(`  ${pc.green('\u2714')} Excluded ${excluded.length} domain${excluded.length === 1 ? '' : 's'}`);
  } else {
    console.log(`  ${pc.green('\u2714')} AI recommendations accepted`);
  }
  return true;
}

async function handleOutlineReview(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const outline = (data.outline ?? '') as string;
  const sections = (data.sections ?? []) as string[];

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold('Checkpoint: Outline Review')}`);
  console.log(SEPARATOR);
  console.log('');

  if (sections.length > 0) {
    console.log(`  ${pc.bold('Sections:')}`);
    for (let i = 0; i < sections.length; i++) {
      console.log(`    ${pc.dim(`${i + 1}.`)} ${sections[i]}`);
    }
    console.log('');
  }

  if (outline) {
    console.log(`  ${pc.bold('Outline:')}`);
    console.log('');
    for (const line of outline.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log('');
  }

  const approved = await p.confirm({
    message: 'Approve this outline?',
  });

  if (p.isCancel(approved)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  if (approved) {
    const { error } = await client.respondResearch(id, interactionId, { approved: true });
    if (error) {
      console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
      return false;
    }
    console.log(`  ${pc.green('\u2714')} Outline approved`);
    return true;
  }

  const modifications = await p.text({
    message: 'What modifications would you like?',
  });

  if (p.isCancel(modifications)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  const { error } = await client.respondResearch(id, interactionId, {
    approved: false,
    modifications,
  });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
    return false;
  }

  console.log(`  ${pc.green('\u2714')} Modifications submitted`);
  return true;
}

async function handleInteraction(
  client: ValyuClient,
  id: string,
  interaction: NonNullable<ResearchStatus['interaction']>,
): Promise<boolean> {
  const { interaction_id, type, data } = interaction;

  switch (type) {
    case 'planning_questions':
      return handlePlanningQuestions(client, id, interaction_id, data);
    case 'plan_review':
      return handlePlanReview(client, id, interaction_id, data);
    case 'source_review':
      return handleSourceReview(client, id, interaction_id, data);
    case 'outline_review':
      return handleOutlineReview(client, id, interaction_id, data);
    default:
      console.log(`  ${pc.yellow('\u26a0')} Unknown checkpoint type: ${type}`);
      return false;
  }
}

// ─── watch loop ─────────────────────────────────────────────────────────────

function progressLine(status: ResearchStatus): string {
  return status.progress
    ? `Researching... step ${status.progress.current_step}/${status.progress.total_steps}`
    : `Researching... (${status.status})`;
}

/** How to answer a paused task's checkpoint without the interactive prompts. */
function checkpointHint(id: string, status: ResearchStatus): string | undefined {
  const interaction = status.interaction;
  if (!interaction) return undefined;
  const shape = RESPONSE_SHAPES[interaction.type] ?? '(see interaction.data)';
  return (
    `Paused at a ${interaction.type} checkpoint. Put it to the user, then answer with: ` +
    `valyu deepresearch respond ${id} --response '<json>' where <json> is ${shape}`
  );
}

export async function watchResearch(
  client: ValyuClient,
  id: string,
  globalOpts: GlobalOpts,
): Promise<void> {
  const machine = globalOpts.json || !process.stdout.isTTY;
  let polls = 0;
  let transientFailures = 0;
  let spinner = createSpinner('Waiting for research to complete...', globalOpts.quiet);

  while (polls < MAX_POLLS) {
    const { data, error } = await client.getResearchStatus(id);

    // A watch can run for hours; one gateway timeout should not end it.
    const transient = !data && (!error || /^(network_error|http_429|http_5\d\d)$/.test(error.code ?? ''));
    if (transient && ++transientFailures <= MAX_TRANSIENT_FAILURES) {
      await sleep(POLL_MS);
      polls++;
      continue;
    }
    if (error || !data) {
      spinner.fail('Failed to fetch status');
      return outputError(
        { message: error?.message ?? 'Empty status response', code: error?.code ?? 'status_failed' },
        { json: globalOpts.json },
      );
    }

    transientFailures = 0;
    const status = withoutTranscript(data);

    if (status.status === 'completed') {
      spinner.stop('Research complete');
      if (machine) {
        outputResult(status, { json: true });
        return;
      }
      renderResearchStatus(status);
      return;
    }

    if (status.status === 'failed' || status.status === 'cancelled') {
      spinner.fail(`Research ${status.status}`);
      return outputError(
        {
          message: status.error ?? `Research task ${status.status}`,
          code: `research_${status.status}`,
        },
        { json: globalOpts.json },
      );
    }

    if ((status.status === 'awaiting_input' || status.status === 'paused') && status.interaction) {
      spinner.warn('Task paused - input required');

      // Without a terminal to prompt in, hand back the checkpoint and how to answer it.
      if (machine || !isInteractive()) {
        outputResult({ ...status, hint: checkpointHint(id, status) }, { json: true });
        return;
      }
      if (!(await handleInteraction(client, id, status.interaction))) return;

      spinner = createSpinner('Waiting for research to continue...', globalOpts.quiet);
    } else {
      spinner.update(progressLine(status));
    }

    await sleep(POLL_MS);
    polls++;
  }

  spinner.fail('Timed out waiting for research');
  outputError(
    { message: `Still running. Check later with: valyu deepresearch status ${id}`, code: 'timeout' },
    { json: globalOpts.json },
  );
}

// ─── render ─────────────────────────────────────────────────────────────────

function renderResearchStatus(status: ResearchStatus): void {
  const id = taskId(status);

  console.log('');
  console.log(`  ${pc.bold('Task ID:')}    ${pc.cyan(id)}`);
  console.log(`  ${pc.bold('Status:')}     ${colorStatus(status.status)}`);
  if (status.mode) console.log(`  ${pc.bold('Mode:')}       ${status.mode}`);
  const label = status.title ?? status.query;
  if (label) console.log(`  ${pc.bold('Query:')}      ${label}`);
  if (status.progress) {
    const { current_step, total_steps } = status.progress;
    console.log(`  ${pc.bold('Progress:')}   step ${current_step}/${total_steps}`);
  }

  if (status.status === 'failed') {
    console.log(`  ${pc.bold('Error:')}      ${pc.red(status.error ?? 'unknown error')}`);
  } else if (status.status === 'awaiting_input' || status.status === 'paused') {
    const hint = checkpointHint(id, status);
    if (hint) {
      console.log('');
      console.log(`  ${pc.yellow('!')} ${hint}`);
      console.log('');
      for (const line of JSON.stringify(status.interaction?.data ?? {}, null, 2).split('\n')) console.log(`  ${pc.dim(line)}`);
    }
    console.log('');
    console.log(`  ${pc.dim('Or answer interactively:')} valyu deepresearch watch ${id}`);
  } else if (!TERMINAL.has(status.status)) {
    console.log('');
    console.log(`  ${pc.dim('Still running. Check back later, or wait with:')} valyu deepresearch watch ${id}`);
  }

  if (status.status === 'completed') {
    console.log('');
    console.log(SEPARATOR);
    console.log('');
    if (typeof status.output === 'string') console.log(status.output);
    else if (status.output != null) console.log(JSON.stringify(status.output, null, 2));
    if (status.structured_output && typeof status.structured_output === 'object') {
      console.log(JSON.stringify(status.structured_output, null, 2));
    }

    const files: string[] = [];
    if (status.pdf_url) files.push(`PDF  ${pc.cyan(status.pdf_url)}`);
    for (const d of status.deliverables ?? []) {
      const icon = d.status === 'completed' ? pc.green('\u2713') : pc.red('\u2717');
      files.push(`${icon} ${d.type.toUpperCase()} ${d.title ?? ''}${d.url ? `  ${pc.cyan(d.url)}` : ''}${d.error ? `  ${pc.red(d.error)}` : ''}`);
    }
    for (const img of status.images ?? []) {
      if (img.image_url) files.push(`image ${img.title ?? ''}  ${pc.cyan(img.image_url)}`);
    }
    if (files.length) {
      console.log('');
      console.log(`  ${pc.bold('Files:')}`);
      for (const f of files) console.log(`    ${f}`);
    }

    if (status.sources?.length) {
      console.log('');
      console.log(`  ${pc.bold('Sources:')}    ${pc.dim(`${status.sources.length} cited`)}`);
      for (const s of status.sources.slice(0, 10)) {
        console.log(`    ${pc.dim('\u00b7')} ${(s.title ?? s.url).slice(0, 70)}  ${pc.dim(s.url)}`);
      }
      if (status.sources.length > 10) {
        console.log(`    ${pc.dim(`... and ${status.sources.length - 10} more (--json for all)`)}`);
      }
    }

    const cost = status.cost ?? status.usage?.total_cost;
    if (cost != null) {
      console.log('');
      console.log(`  ${pc.bold('Cost:')}       ${pc.dim('$' + cost.toFixed(2))}`);
    }
  }

  console.log('');
}

// ─── export ─────────────────────────────────────────────────────────────────

export const deepresearchCommand = new Command('deepresearch')
  .description('Asynchronous deep research: a cited report in minutes to hours (start, check, steer, answer, share)')
  .addCommand(createCmd)
  .addCommand(listCmd)
  .addCommand(statusCmd)
  .addCommand(watchCmd)
  .addCommand(cancelCmd)
  .addCommand(steerCmd)
  .addCommand(respondCmd)
  .addCommand(deleteCmd)
  .addCommand(shareCmd);
