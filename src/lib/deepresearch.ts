// Pure helpers shared by the deepresearch, batch and workflows commands.

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
