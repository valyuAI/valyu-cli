import { Command } from '@commander-js/extra-typings';
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
import { outputError, outputResult } from '../../lib/output.js';
import { renderResearch } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';

const MODES = ['fast', 'standard', 'heavy', 'max'] as const;
type Mode = (typeof MODES)[number];

const MODE_DESC: Record<Mode, string> = {
  fast: '~5 min - quick lookups',
  standard: '~10-20 min - balanced (default)',
  heavy: '~60 min - in-depth analysis',
  max: '~90 min - maximum depth',
};

const POLL_MS = 5000;
const MAX_POLLS = 1080;

function taskId(t: Record<string, unknown>): string {
  return String(t.deepresearch_id ?? t.id ?? t.task_id ?? '');
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
  awaiting_input: pc.yellow,
  paused: pc.yellow,
  completed: pc.green,
  failed: pc.red,
  cancelled: pc.dim,
};

function colorStatus(s: string): string {
  return (STATUS_COLOR[s] ?? pc.white)(s);
}

const SEPARATOR = pc.dim('  ' + '\u2500'.repeat(40));

// ─── create ─────────────────────────────────────────────────────────────────

const createCmd = new Command('create')
  .description('Start a deep research task')
  .argument('<query>', 'Research query')
  .option('-m, --mode <mode>', `Research depth: ${MODES.join(', ')} (default: standard)`, 'standard')
  .option('--no-pdf', 'Skip PDF generation')
  .option('-w, --watch', 'Wait for completion and display result')
  .addHelpText(
    'after',
    `
${pc.dim('Modes:')}

${MODES.map((m) => `  ${pc.cyan(m.padEnd(10))} ${MODE_DESC[m]}`).join('\n')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu deepresearch create "AI infrastructure market analysis 2025"')}
  ${pc.dim('$ valyu deepresearch create "CRISPR therapeutics landscape" --mode heavy')}
  ${pc.dim('$ valyu deepresearch create "Tesla competitive positioning" --watch')}
`,
  )
  .action(async (query, opts, cmd) => {
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
    const spinner = createSpinner('Creating research task...', globalOpts.quiet);

    const formats = opts.pdf === false ? ['markdown'] : ['markdown', 'pdf'];

    const { data, error } = await client.createResearch({
      query,
      mode: opts.mode,
      outputFormats: formats,
    });

    if (error) {
      spinner.fail('Failed to create research task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const task = data! as Record<string, unknown>;
    const id = taskId(task);
    spinner.stop(`Research task created: ${pc.cyan(id)}`);

    if (!opts.watch) {
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(task, { json: true });
        return;
      }

      console.log('');
      console.log(`  ${pc.bold('Task ID:')}  ${pc.cyan(id)}`);
      console.log(`  ${pc.bold('Mode:')}     ${task.mode ?? opts.mode}`);
      console.log(`  ${pc.bold('Status:')}   ${colorStatus(String(task.status))}`);
      console.log(`  ${pc.bold('PDF:')}      ${formats.includes('pdf') ? pc.green('yes') : pc.dim('no')}`);
      console.log('');
      console.log(`  ${pc.dim('Watch:')}  valyu deepresearch watch ${id}`);
      console.log(`  ${pc.dim('Status:')} valyu deepresearch status ${id}`);
      console.log(`  ${pc.dim('Cancel:')} valyu deepresearch cancel ${id}`);
      console.log('');
      return;
    }

    await watchResearch(client, id, globalOpts);
  });

// ─── list ───────────────────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List all research tasks')
  .option('-n, --limit <n>', 'Max results', '20')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading tasks...', globalOpts.quiet);

    const { data, error } = await client.listResearch(Number(opts.limit) || 20);

    if (error) {
      spinner.fail('Failed to list tasks');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    const raw = data as ResearchListResult;
    const tasks: ResearchListItem[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
    spinner.stop(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(tasks, { json: true });
      return;
    }

    if (tasks.length === 0) {
      console.log(`\n  ${pc.dim('No research tasks found. Create one with:')} valyu deepresearch create "query"\n`);
      return;
    }

    console.log('');
    for (const t of tasks) {
      const status = colorStatus(t.status);
      const time = relTime(t.created_at);
      const title = (t as Record<string, unknown>).title as string | undefined;
      const label = title ?? t.query;
      const q = label.length > 60 ? label.slice(0, 57) + '...' : label;
      console.log(`  ${pc.cyan(t.deepresearch_id)}`);
      console.log(`  ${status}  ${pc.dim(time)}  ${q}`);
      console.log('');
    }
    console.log(`  ${pc.dim('View details:')} valyu deepresearch status <id>\n`);
  });

// ─── status ─────────────────────────────────────────────────────────────────

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

    const status = data!;
    spinner.stop(`Status: ${colorStatus(status.status)}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
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
  .description('Cancel a running research task')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Cancelling task...', globalOpts.quiet);

    const { error } = await client.cancelResearch(id);

    if (error) {
      spinner.fail('Failed to cancel task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} cancelled`);
  });

// ─── update ─────────────────────────────────────────────────────────────────

const updateCmd = new Command('update')
  .description('Add a follow-up instruction to a running research task')
  .argument('<id>', 'Research task ID')
  .argument('<instruction>', 'Follow-up instruction')
  .action(async (id, instruction, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Sending instruction...', globalOpts.quiet);

    const { data, error } = await client.updateResearch(id, instruction);

    if (error) {
      spinner.fail('Failed to update task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    spinner.stop(`Instruction sent to task ${pc.cyan(id.slice(0, 8))}`);

    if (globalOpts.json) {
      outputResult(data, { json: true });
    }
  });

// ─── delete ─────────────────────────────────────────────────────────────────

const deleteCmd = new Command('delete')
  .description('Delete a research task')
  .argument('<id>', 'Research task ID')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
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

    const { error } = await client.deleteResearch(id);

    if (error) {
      spinner.fail('Failed to delete task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
    }

    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} deleted`);
  });

// ─── share ──────────────────────────────────────────────────────────────────

const shareCmd = new Command('share')
  .description('Toggle public access for a research task')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    // Get current status to check public state
    const spinnerCheck = createSpinner('Checking task...', globalOpts.quiet);
    const { data: status, error: statusError } = await client.getResearchStatus(id);

    if (statusError) {
      spinnerCheck.fail('Failed to fetch task');
      outputError({ message: statusError.message, code: statusError.code }, { json: globalOpts.json });
      return;
    }

    const currentlyPublic = (status as Record<string, unknown>)?.public === true;
    const newPublic = !currentlyPublic;
    spinnerCheck.stop(currentlyPublic ? 'Currently public - toggling off' : 'Currently private - toggling on');

    const spinner = createSpinner(newPublic ? 'Making task public...' : 'Making task private...', globalOpts.quiet);
    const { data, error } = await client.toggleResearchPublic(id, newPublic);

    if (error) {
      spinner.fail('Failed to toggle public access');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    if (newPublic) {
      const publicUrl = `${PLATFORM_URL}/research/${id}`;
      spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} is now ${pc.green('public')}`);
      console.log('');
      console.log(`  ${pc.bold('Public URL:')}  ${pc.cyan(publicUrl)}`);
      console.log('');
    } else {
      spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} is now ${pc.dim('private')}`);
    }

    if (globalOpts.json) {
      outputResult(data, { json: true });
    }
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

  const answers: Record<string, string> = {};

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
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

    answers[`q${i}`] = answer;
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

async function watchResearch(
  client: ValyuClient,
  id: string,
  globalOpts: GlobalOpts,
): Promise<void> {
  let polls = 0;
  let spinner = createSpinner('Waiting for research to complete...', globalOpts.quiet);

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
      renderResearchStatus(status);
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

    // HITL: handle interactive checkpoints
    if ((status.status === 'awaiting_input' || status.status === 'paused') && status.interaction) {
      spinner.warn(`Task paused - input required`);

      const responded = await handleInteraction(client, id, status.interaction);

      if (!responded) {
        // User cancelled the interaction - exit watch
        return;
      }

      // Restart spinner and continue polling
      spinner = createSpinner('Waiting for research to continue...', globalOpts.quiet);
      await new Promise((r) => setTimeout(r, POLL_MS));
      polls++;
      continue;
    }

    if (status.progress) {
      const { current_step, total_steps } = status.progress;
      spinner.update(`Researching... step ${current_step}/${total_steps}`);
    } else {
      spinner.update(`Researching... (${status.status})`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
    polls++;
  }

  spinner.fail('Timed out waiting for research');
  outputError(
    { message: `Use 'valyu deepresearch status ${id}' to check later.`, code: 'timeout' },
    { json: globalOpts.json },
  );
}

// ─── render ─────────────────────────────────────────────────────────────────

function renderResearchStatus(status: ResearchStatus): void {
  const id = status.deepresearch_id ?? status.id ?? status.task_id ?? '';

  console.log('');
  console.log(`  ${pc.bold('Task ID:')}    ${pc.cyan(id)}`);
  console.log(`  ${pc.bold('Status:')}     ${colorStatus(status.status)}`);
  if (status.mode) console.log(`  ${pc.bold('Mode:')}       ${status.mode}`);
  if (status.query) console.log(`  ${pc.bold('Query:')}      ${status.query}`);
  if (status.progress) {
    const { current_step, total_steps } = status.progress;
    const pct = Math.round((current_step / total_steps) * 100);
    console.log(`  ${pc.bold('Progress:')}   ${current_step}/${total_steps} (${pct}%)`);
  }

  if (status.status === 'completed') {
    // Output
    if (status.output && typeof status.output === 'string') {
      console.log('');
      console.log(pc.dim('  \u2500'.repeat(30)));
      console.log('');
      // Print first 2000 chars with note to use --json for full
      const preview = status.output.length > 2000
        ? status.output.slice(0, 2000) + '\n\n  ...'
        : status.output;
      console.log(preview);
    }

    // PDF
    if (status.pdf_url) {
      console.log('');
      console.log(`  ${pc.bold('PDF:')}        ${pc.cyan(status.pdf_url)}`);
    }

    // Deliverables
    if (status.deliverables?.length) {
      console.log('');
      console.log(`  ${pc.bold('Deliverables:')}`);
      for (const d of status.deliverables) {
        const icon = d.status === 'completed' ? pc.green('\u2713') : pc.red('\u2717');
        console.log(`    ${icon} ${d.type.toUpperCase()} - ${d.title ?? d.type}${d.url ? `  ${pc.cyan(d.url)}` : ''}${d.error ? `  ${pc.red(d.error)}` : ''}`);
      }
    }

    // Sources
    if (status.sources?.length) {
      console.log('');
      console.log(`  ${pc.bold('Sources:')}    ${pc.dim(`${status.sources.length} used`)}`);
      for (const s of status.sources.slice(0, 10)) {
        console.log(`    ${pc.dim('\u00b7')} ${s.title.slice(0, 70)}${s.title.length > 70 ? '...' : ''}`);
      }
      if (status.sources.length > 10) {
        console.log(`    ${pc.dim(`... and ${status.sources.length - 10} more`)}`);
      }
    }

    // Cost
    const cost = status.cost ?? status.usage?.total_cost;
    if (cost != null) {
      console.log('');
      console.log(`  ${pc.bold('Cost:')}       ${pc.dim('$' + cost.toFixed(4))}`);
    }
  }

  console.log('');
}

// ─── export ─────────────────────────────────────────────────────────────────

export const researchCommand = new Command('deepresearch')
  .description('Deep research - AI-synthesized reports with sources')
  .addCommand(createCmd)
  .addCommand(listCmd)
  .addCommand(statusCmd)
  .addCommand(watchCmd)
  .addCommand(cancelCmd)
  .addCommand(updateCmd)
  .addCommand(deleteCmd)
  .addCommand(shareCmd);
