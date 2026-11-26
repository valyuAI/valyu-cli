import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type {
  GlobalOpts,
  ResearchEdit,
  ResearchEditTarget,
  ValyuApiError,
} from '../../lib/client.js';
import { requireApiKey, ValyuClient } from '../../lib/client.js';
import {
  describeChange,
  EDIT_WAIT_SECONDS,
  editExitCode,
  editFocus,
  editPollDelayMs,
  isEditDone,
  MAX_EDIT_WAIT_MS,
  MAX_INSTRUCTION_CHARS,
} from '../../lib/deepresearch.js';
import { colorStatus, relTime } from '../../lib/format.js';
import { outputError, outputResult, printWarnings } from '../../lib/output.js';
import { parsePositiveInt } from '../../lib/parsers.js';
import { createSpinner, type Spinner } from '../../lib/spinner.js';

export const EDIT_DESCRIPTION =
  'Make small, targeted edits to a finished DeepResearch report or deliverable with a plain-language instruction. Untouched text stays exactly as it was, citations stay consistent, and every edit creates a new version you can restore.';

const CITATION_MODES = ['stable', 'compact'] as const;

function wantsJson(globalOpts: GlobalOpts): boolean {
  return Boolean(globalOpts.json) || !process.stdout.isTTY;
}

function targetLabel(target: ResearchEditTarget | null | undefined): string {
  return target?.kind === 'deliverable' ? `deliverable ${target.deliverable_id}` : 'report';
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Poll an edit until it is applied, declined or failed. Returns the last record
 * seen, which is still `running` if the wait timed out.
 */
async function waitForEdit(
  client: ValyuClient,
  taskId: string,
  edit: ResearchEdit,
  spinner: Spinner,
): Promise<{ edit: ResearchEdit; error: ValyuApiError | null }> {
  const started = Date.now();
  let current = edit;
  const label = `Editing ${targetLabel(edit.target)} (${edit.edit_id})`;
  while (!isEditDone(current)) {
    const elapsed = Date.now() - started;
    if (elapsed >= MAX_EDIT_WAIT_MS) break;
    spinner.update(`${label}... ${Math.round(elapsed / 1000)}s`);
    await new Promise((r) => setTimeout(r, editPollDelayMs(current)));
    const { data, error } = await client.getResearchEdit(taskId, edit.edit_id);
    if (error || !data) return { edit: current, error };
    current = data;
  }
  return { edit: current, error: null };
}

function printLine(label: string, value: string): void {
  console.log(`  ${pc.bold(label.padEnd(12))}${value}`);
}

function renderEdit(edit: ResearchEdit, taskId: string): void {
  console.log('');
  printLine('Edit ID:', pc.cyan(edit.edit_id));
  printLine('Status:', colorStatus(edit.status));
  printLine('Target:', targetLabel(edit.target));
  if (edit.version != null) {
    printLine(
      'Version:',
      `${edit.version}${edit.base_version ? pc.dim(` (from ${edit.base_version})`) : ''}`,
    );
  } else if (edit.base_version != null) {
    printLine('Base:', `version ${edit.base_version}`);
  }
  if (edit.summary) printLine('Summary:', edit.summary);

  if (edit.decline) {
    printLine('Declined:', `${edit.decline.message} ${pc.dim(`(${edit.decline.code})`)}`);
    if (edit.decline.suggestion) printLine('Suggestion:', edit.decline.suggestion);
  }
  if (edit.status === 'failed' && edit.error) {
    const code = edit.error.code ? pc.dim(` (${edit.error.code})`) : '';
    printLine('Error:', `${edit.error.message ?? 'Edit failed'}${code}`);
    if (edit.error.retryable) printLine('', pc.dim('Safe to submit the edit again.'));
  }

  if (edit.changes?.length) {
    console.log('');
    console.log(`  ${pc.bold('Changes:')}`);
    for (const change of edit.changes) console.log(`    ${pc.dim('·')} ${describeChange(change)}`);
  }
  if (edit.unapplied?.length) {
    console.log('');
    console.log(`  ${pc.bold('Not applied:')}`);
    for (const item of edit.unapplied) {
      const text = typeof item === 'string' ? item : describeChange(item);
      console.log(`    ${pc.dim('·')} ${text}`);
    }
  }
  if (edit.stats && Object.keys(edit.stats).length) {
    console.log('');
    printLine(
      'Stats:',
      pc.dim(
        Object.entries(edit.stats)
          .map(
            ([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : v}`,
          )
          .join(', '),
      ),
    );
  }
  if (edit.pdf_url) printLine('PDF:', pc.cyan(edit.pdf_url));

  console.log('');
  if (edit.status === 'running') {
    console.log(
      `  ${pc.dim('Wait:')}    valyu deepresearch edit-status ${taskId} ${edit.edit_id} --wait`,
    );
  } else if (edit.status === 'applied') {
    console.log(`  ${pc.dim('View:')}    valyu deepresearch status ${taskId}`);
    if (edit.base_version) {
      console.log(
        `  ${pc.dim('Undo:')}    valyu deepresearch restore ${taskId} ${edit.base_version}`,
      );
    }
  }
  console.log('');
  printWarnings(edit.warnings);
}

/** Print a finished (or still running) edit and exit with its status code. */
function finishEdit(edit: ResearchEdit, taskId: string, globalOpts: GlobalOpts): void {
  const exitCode = isEditDone(edit) ? editExitCode(edit) : 0;
  if (wantsJson(globalOpts)) {
    outputResult(edit, { json: true, exitCode });
    return;
  }
  renderEdit(edit, taskId);
  if (exitCode !== 0) process.exit(exitCode);
}

function stopSpinner(spinner: Spinner, edit: ResearchEdit): void {
  if (edit.status === 'applied') {
    spinner.stop(`Edit applied: version ${edit.version ?? '?'}`);
  } else if (edit.status === 'declined') {
    spinner.warn(
      edit.decline?.code === 'edit.no_change'
        ? 'No change needed: the report already matches the instruction'
        : `Edit declined${edit.decline?.code ? ` (${edit.decline.code})` : ''}`,
    );
  } else if (edit.status === 'failed') {
    spinner.fail('Edit failed');
  } else {
    spinner.warn(`Edit still running: ${edit.edit_id}`);
  }
}

// ─── edit ───────────────────────────────────────────────────────────────────

export const editCmd = new Command('edit')
  .summary('Edit a finished report or deliverable with a plain-language instruction')
  .description(EDIT_DESCRIPTION)
  .argument('<task-id>', 'Research task ID (must be completed)')
  .argument('<instruction>', 'What to change, in plain language (pass "-" to read from stdin)')
  .option('--section <heading>', 'Focus the edit on the section with this heading')
  .option('--text <passage>', 'Focus the edit on this exact passage of the report')
  .option('--prefix <text>', 'Text just before --text, to tell repeated passages apart')
  .option('--suffix <text>', 'Text just after --text, to tell repeated passages apart')
  .option('--start-char <n>', 'Start offset of the passage in the report markdown')
  .option('--end-char <n>', 'End offset of the passage (use with --start-char)')
  .option('--strict', 'Reject any change outside the focused section or passage')
  .option('--deliverable <id>', 'Edit a deliverable file (e.g. f_01) instead of the report')
  .option('--base-version <n>', 'Version you are editing; fails if the report has moved on since')
  .option(
    '--citations <mode>',
    `Citation numbering: ${CITATION_MODES.join(', ')} (default: stable)`,
  )
  .option(
    '--idempotency-key <key>',
    'Retry-safe key: resending with the same key returns the same edit',
  )
  .option('--no-wait', 'Return the edit ID straight away instead of waiting for the result')
  .addHelpText(
    'after',
    `
${pc.dim('Use it to refine a report you already have (fix a figure, tighten a section,')}
${pc.dim('change tone, add a cited point from the sources the task gathered) instead of')}
${pc.dim('running new research. Large rewrites are declined; start a new task for those.')}

${pc.dim('Exit codes: 0 applied (or nothing to change), 1 failed or error, 2 declined.')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu deepresearch edit <id> "Cut the executive summary to 3 bullets" --section "Executive Summary"')}
  ${pc.dim('$ valyu deepresearch edit <id> "Soften this claim" --text "Margins will expand by 250 bps." --strict')}
  ${pc.dim('$ valyu deepresearch edit <id> "Add a YoY growth % column" --deliverable f_01')}
  ${pc.dim('$ valyu deepresearch edit <id> "Fix the Q3 revenue figure" --no-wait')}
  ${pc.dim('$ valyu deepresearch versions <id>')}
  ${pc.dim('$ valyu deepresearch restore <id> 1')}
`,
  )
  .action(async (taskId, instruction, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (instruction === '-') {
      const { readStdin } = await import('../../lib/stdin.js');
      instruction = ((await readStdin()) ?? '').trim();
    }
    if (!instruction.trim()) {
      fail('Provide an instruction describing the change', 'missing_instruction');
      return;
    }
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      fail(`Instruction must be at most ${MAX_INSTRUCTION_CHARS} characters`, 'invalid_option');
      return;
    }
    if (
      opts.citations &&
      !CITATION_MODES.includes(opts.citations as (typeof CITATION_MODES)[number])
    ) {
      fail(
        `Invalid --citations '${opts.citations}'. Valid: ${CITATION_MODES.join(', ')}`,
        'invalid_option',
      );
      return;
    }

    let focus: ReturnType<typeof editFocus>;
    let baseVersion: number | undefined;
    try {
      focus = editFocus(opts);
      baseVersion = opts.baseVersion
        ? parsePositiveInt(opts.baseVersion, '--base-version')
        : undefined;
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Invalid option', 'invalid_option');
      return;
    }
    const target: ResearchEditTarget | undefined = opts.deliverable
      ? { kind: 'deliverable', deliverable_id: opts.deliverable }
      : undefined;

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(`Editing ${targetLabel(target)}...`, globalOpts.quiet);

    const { data, error } = await client.editResearch(taskId, {
      instruction,
      target,
      focus,
      baseVersion,
      citations: opts.citations as (typeof CITATION_MODES)[number] | undefined,
      waitSeconds: opts.wait ? EDIT_WAIT_SECONDS : 0,
      idempotencyKey: opts.idempotencyKey,
    });
    if (error || !data) {
      spinner.fail('Edit not started');
      outputError(error ?? { message: 'Empty response', code: 'empty_response' }, {
        json: globalOpts.json,
      });
      return;
    }

    let edit = data;
    if (!opts.wait && !isEditDone(edit)) {
      spinner.stop(`Edit started: ${pc.cyan(edit.edit_id)}`);
      finishEdit(edit, taskId, globalOpts);
      return;
    }

    if (!isEditDone(edit)) {
      const waited = await waitForEdit(client, taskId, edit, spinner);
      if (waited.error) {
        spinner.fail('Failed to fetch edit status');
        outputError(waited.error, { json: globalOpts.json });
        return;
      }
      edit = waited.edit;
    }
    stopSpinner(spinner, edit);
    finishEdit(edit, taskId, globalOpts);
  });

// ─── edit-status ────────────────────────────────────────────────────────────

export const editStatusCmd = new Command('edit-status')
  .description('Show the result of a report edit')
  .argument('<task-id>', 'Research task ID')
  .argument('<edit-id>', 'Edit ID returned by `valyu deepresearch edit`')
  .option('-w, --wait', 'Wait until the edit is applied, declined or failed')
  .action(async (taskId, editId, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Fetching edit...', globalOpts.quiet);

    const { data, error } = await client.getResearchEdit(taskId, editId);
    if (error || !data) {
      spinner.fail('Failed to fetch edit');
      outputError(error ?? { message: 'Empty response', code: 'empty_response' }, {
        json: globalOpts.json,
      });
      return;
    }

    let edit = data;
    if (opts.wait && !isEditDone(edit)) {
      const waited = await waitForEdit(client, taskId, edit, spinner);
      if (waited.error) {
        spinner.fail('Failed to fetch edit status');
        outputError(waited.error, { json: globalOpts.json });
        return;
      }
      edit = waited.edit;
    }
    stopSpinner(spinner, edit);
    finishEdit(edit, taskId, globalOpts);
  });

// ─── edits ──────────────────────────────────────────────────────────────────

export const editsCmd = new Command('edits')
  .description('List the edits made to a research task')
  .argument('<task-id>', 'Research task ID')
  .action(async (taskId, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading edits...', globalOpts.quiet);

    const { data, error } = await client.listResearchEdits(taskId);
    if (error) {
      spinner.fail('Failed to list edits');
      outputError(error, { json: globalOpts.json });
      return;
    }
    const edits = data?.edits ?? [];
    spinner.stop(`${edits.length} edit${edits.length === 1 ? '' : 's'}`);

    if (wantsJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    if (edits.length === 0) {
      console.log(
        `\n  ${pc.dim('No edits yet. Make one with:')} valyu deepresearch edit ${taskId} "<instruction>"\n`,
      );
      return;
    }
    console.log('');
    for (const e of edits) {
      const version = e.version != null ? `v${e.version}` : '';
      console.log(
        `  ${pc.cyan(e.edit_id)}  ${colorStatus(e.status)}  ${pc.dim(relTime(e.created_at))}  ${version}`,
      );
      const detail = e.summary ?? e.decline?.message ?? e.error?.message;
      if (detail) console.log(`  ${pc.dim(truncate(detail, 100))}`);
      console.log('');
    }
  });

// ─── versions ───────────────────────────────────────────────────────────────

export const versionsCmd = new Command('versions')
  .description('List the versions of a research report')
  .argument('<task-id>', 'Research task ID')
  .action(async (taskId, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading versions...', globalOpts.quiet);

    const { data, error } = await client.listResearchVersions(taskId);
    if (error) {
      spinner.fail('Failed to list versions');
      outputError(error, { json: globalOpts.json });
      return;
    }
    const versions = data?.versions ?? [];
    spinner.stop(`${versions.length} version${versions.length === 1 ? '' : 's'}`);

    if (wantsJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    console.log('');
    for (const v of versions) {
      const head = v.is_head ? pc.green(' (current)') : '';
      const target =
        v.kind === 'edit' && v.target?.kind === 'deliverable' ? ` ${targetLabel(v.target)}` : '';
      console.log(
        `  ${pc.bold(`v${v.version}`.padEnd(5))} ${v.kind.padEnd(8)} ${pc.dim(relTime(v.created_at).padEnd(8))}${target}${head}`,
      );
      const detail = v.summary ?? v.instruction;
      if (detail) console.log(`        ${pc.dim(truncate(detail, 100))}`);
    }
    console.log('');
    console.log(
      `  ${pc.dim('Read a version:')}    valyu deepresearch status ${taskId} --version <n>`,
    );
    console.log(`  ${pc.dim('Restore a version:')} valyu deepresearch restore ${taskId} <n>`);
    console.log('');
  });

// ─── restore ────────────────────────────────────────────────────────────────

export const restoreCmd = new Command('restore')
  .description('Restore an earlier version of a research report as the new current version')
  .argument('<task-id>', 'Research task ID')
  .argument('<version>', 'Version number to restore (see `valyu deepresearch versions`)')
  .addHelpText(
    'after',
    `
${pc.dim('Restoring adds a new version with the old content. No history is deleted, so a')}
${pc.dim('restore can itself be undone by restoring the version before it.')}
`,
  )
  .action(async (taskId, versionArg, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    let version: number;
    try {
      version = parsePositiveInt(versionArg, 'Version');
    } catch (err) {
      outputError(
        { message: err instanceof Error ? err.message : 'Invalid version', code: 'invalid_option' },
        { json: globalOpts.json },
      );
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner(`Restoring version ${version}...`, globalOpts.quiet);

    const { data, error } = await client.restoreResearchVersion(taskId, version);
    if (error || !data) {
      spinner.fail('Restore failed');
      outputError(error ?? { message: 'Empty response', code: 'empty_response' }, {
        json: globalOpts.json,
      });
      return;
    }

    spinner.stop(`Restored version ${data.restored_from} as version ${data.version}`);
    if (wantsJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    console.log(`\n  ${pc.dim('View:')} valyu deepresearch status ${taskId}\n`);
  });
