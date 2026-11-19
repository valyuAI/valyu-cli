// Pure helpers shared by the deepresearch, batch and workflows commands.

import type { ResearchEdit, ResearchEditFocus } from './client.js';

export const POLL_MS = 5000;
// Long enough for `max` mode (up to ~2 hrs) with headroom.
export const MAX_WATCH_MS = 3 * 60 * 60 * 1000;
export const MAX_POLLS = MAX_WATCH_MS / POLL_MS;

// Some modes (e.g. `instant`) are reported in `research_mode` with no `mode`.
export function researchMode(task: {
  mode?: unknown;
  research_mode?: unknown;
}): string | undefined {
  const mode = task.mode ?? task.research_mode;
  return typeof mode === 'string' && mode ? mode : undefined;
}

export function researchLabel(task: { title?: unknown; query?: unknown; input?: unknown }): string {
  for (const value of [task.title, task.query, task.input]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '(untitled)';
}

export function planningAnswers(
  questions: Array<{ question: string }>,
  answers: string[],
): { answers: Array<{ question: string; answer: string }> } {
  return { answers: questions.map((q, i) => ({ question: q.question, answer: answers[i] ?? '' })) };
}

// ─── batches ────────────────────────────────────────────────────────────────

export interface BatchCounts {
  total: number;
  completed: number;
  running: number;
  queued: number;
  failed: number;
  cancelled: number;
}

export function batchCounts(batch: Record<string, unknown>): BatchCounts {
  const counts = (batch.counts ?? {}) as Record<string, unknown>;
  const num = (...values: unknown[]): number => {
    const found = values.find((v) => v != null);
    return Number(found ?? 0) || 0;
  };
  const total = num(counts.total, batch.total_tasks, batch.total);
  const completed = num(counts.completed, batch.completed_tasks, batch.completed);
  const running = num(counts.running, batch.running_tasks, batch.running);
  const failed = num(counts.failed, batch.failed_tasks, batch.failed);
  const cancelled = num(counts.cancelled, batch.cancelled_tasks, batch.cancelled);
  const queued =
    counts.queued != null
      ? num(counts.queued)
      : Math.max(0, total - completed - running - failed - cancelled);
  return { total, completed, running, queued, failed, cancelled };
}

export const BATCH_DONE_STATUSES: readonly string[] = ['completed', 'completed_with_errors'];
export const BATCH_STOPPED_STATUSES: readonly string[] = ['failed', 'cancelled'];

// `open` with no tasks is just an empty batch waiting for `batch add`.
export function isActiveBatch(batch: Record<string, unknown>): boolean {
  const status = String(batch.status ?? '');
  if (status === 'processing' || status === 'running' || status === 'queued') return true;
  return status === 'open' && batchCounts(batch).total > 0;
}

// ─── report editing ─────────────────────────────────────────────────────────

/** Longest the CLI waits for one edit before telling the user to check later. */
export const MAX_EDIT_WAIT_MS = 30 * 60 * 1000;
/** Seconds the API holds the create request open before replying 202. */
export const EDIT_WAIT_SECONDS = 20;
export const MAX_INSTRUCTION_CHARS = 4000;

export const EDIT_TERMINAL_STATUSES: readonly string[] = ['applied', 'declined', 'failed'];

export function isEditDone(edit: Pick<ResearchEdit, 'status'>): boolean {
  return EDIT_TERMINAL_STATUSES.includes(edit.status);
}

/** Poll delay: the server's `retry_after_seconds`, kept between 1 s and 30 s. */
export function editPollDelayMs(edit: Pick<ResearchEdit, 'retry_after_seconds'>): number {
  const seconds = Number(edit.retry_after_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 3000;
  return Math.min(Math.max(seconds, 1), 30) * 1000;
}

/**
 * Exit code for a finished edit: 0 when applied (or there was nothing to
 * change), 2 when declined, 1 when it failed.
 */
export function editExitCode(edit: Pick<ResearchEdit, 'status' | 'decline'>): number {
  if (edit.status === 'failed') return 1;
  if (edit.status === 'declined') return edit.decline?.code === 'edit.no_change' ? 0 : 2;
  return 0;
}

function parseOffset(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

/**
 * Build the edit `focus` from CLI flags. Returns undefined when no focus flag
 * was given, so the request leaves `focus` out entirely.
 */
export function editFocus(opts: {
  section?: string;
  text?: string;
  prefix?: string;
  suffix?: string;
  startChar?: string;
  endChar?: string;
  strict?: boolean;
}): ResearchEditFocus | undefined {
  const start = parseOffset(opts.startChar, '--start-char');
  const end = parseOffset(opts.endChar, '--end-char');
  if ((start === undefined) !== (end === undefined)) {
    throw new Error('--start-char and --end-char must be used together');
  }
  if (start !== undefined && end !== undefined && end <= start) {
    throw new Error('--end-char must be greater than --start-char');
  }
  const focus: ResearchEditFocus = {};
  if (start !== undefined) focus.start_char = start;
  if (end !== undefined) focus.end_char = end;
  if (opts.text) focus.text = opts.text;
  if (opts.prefix) focus.prefix = opts.prefix;
  if (opts.suffix) focus.suffix = opts.suffix;
  if (opts.section) focus.section = opts.section;
  if (Object.keys(focus).length === 0) {
    if (opts.strict) throw new Error('--strict needs --section, --text or --start-char/--end-char');
    return undefined;
  }
  if (opts.strict) focus.scope = 'strict';
  return focus;
}

function hunkText(lines: unknown): string {
  if (!Array.isArray(lines)) return '';
  const flat = lines
    .filter((l): l is string => typeof l === 'string')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

/**
 * One line per applied change. Changes are usually diff hunks
 * (`{line, removed[], added[]}`); `{section, description}` items are shown as is.
 */
export function describeChange(change: Record<string, unknown>): string {
  const text = [change.description, change.summary, change.kind].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  const section = typeof change.section === 'string' && change.section ? change.section : '';
  if (text) return section ? `${section}: ${text}` : text;

  const line = typeof change.line === 'number' ? `line ${change.line}, ` : '';
  const added = hunkText(change.added);
  if (added) return `${line}now reads: ${added}`;
  const removed = hunkText(change.removed);
  if (removed) return `${line}removed: ${removed}`;
  return JSON.stringify(change);
}
