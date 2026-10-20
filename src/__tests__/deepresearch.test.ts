import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchCounts,
  isActiveBatch,
  MAX_POLLS,
  POLL_MS,
  planningAnswers,
  researchLabel,
  researchMode,
} from '../lib/deepresearch.js';

describe('researchMode', () => {
  it('prefers mode', () => {
    expect(researchMode({ mode: 'fast', research_mode: 'fast' })).toBe('fast');
  });

  it('falls back to research_mode when mode is absent', () => {
    expect(researchMode({ research_mode: 'instant' })).toBe('instant');
  });

  it('returns undefined when neither is set', () => {
    expect(researchMode({})).toBeUndefined();
  });
});

describe('researchLabel', () => {
  it('prefers title, then query, then input', () => {
    expect(researchLabel({ title: 'T', query: 'Q' })).toBe('T');
    expect(researchLabel({ query: 'Q', input: 'I' })).toBe('Q');
    expect(researchLabel({ input: 'I' })).toBe('I');
  });

  it('skips empty strings', () => {
    expect(researchLabel({ title: '  ', query: 'Q' })).toBe('Q');
  });

  it('does not throw on a row with no title or query (e.g. a batch row)', () => {
    expect(researchLabel({})).toBe('(untitled)');
  });
});

describe('planningAnswers', () => {
  it('sends answers as an array of {question, answer}', () => {
    const payload = planningAnswers(
      [{ question: 'Which region?' }, { question: 'Which years?' }],
      ['EU', '2020-2024'],
    );
    expect(payload).toEqual({
      answers: [
        { question: 'Which region?', answer: 'EU' },
        { question: 'Which years?', answer: '2020-2024' },
      ],
    });
    expect(Array.isArray(payload.answers)).toBe(true);
  });

  it('returns an empty array when there are no questions', () => {
    expect(planningAnswers([], [])).toEqual({ answers: [] });
  });
});

describe('batchCounts', () => {
  it('reads the counts object', () => {
    const batch = {
      status: 'processing',
      counts: { total: 5, queued: 1, running: 2, completed: 1, failed: 1, cancelled: 0 },
    };
    expect(batchCounts(batch)).toEqual({
      total: 5,
      queued: 1,
      running: 2,
      completed: 1,
      failed: 1,
      cancelled: 0,
    });
  });

  it('falls back to flat keys and derives queued', () => {
    expect(batchCounts({ total_tasks: 4, completed_tasks: 1, running_tasks: 1 })).toMatchObject({
      total: 4,
      completed: 1,
      running: 1,
      queued: 2,
    });
  });

  it('returns zeros when nothing is reported', () => {
    expect(batchCounts({})).toEqual({
      total: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
  });
});

describe('isActiveBatch', () => {
  it('treats processing batches as active', () => {
    expect(isActiveBatch({ status: 'processing', counts: { total: 2 } })).toBe(true);
  });

  it('treats open batches with tasks as active, empty ones as not', () => {
    expect(isActiveBatch({ status: 'open', counts: { total: 2, queued: 2 } })).toBe(true);
    expect(isActiveBatch({ status: 'open', counts: { total: 0 } })).toBe(false);
  });

  it('treats finished batches as inactive', () => {
    for (const status of ['completed', 'completed_with_errors', 'cancelled']) {
      expect(isActiveBatch({ status, counts: { total: 2 } })).toBe(false);
    }
  });
});

describe('watch limits', () => {
  it('waits long enough for max mode (~2 hrs)', () => {
    expect(MAX_POLLS * POLL_MS).toBeGreaterThan(2 * 60 * 60 * 1000);
  });
});

describe('VALYU_API_BASE', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to the production API', async () => {
    vi.stubEnv('VALYU_API_BASE', '');
    vi.resetModules();
    const { VALYU_API_BASE } = await import('../lib/client.js');
    expect(VALYU_API_BASE).toBe('https://api.valyu.ai/v1');
  });

  it('can be overridden from the environment', async () => {
    vi.stubEnv('VALYU_API_BASE', 'https://example.test/v1/');
    vi.resetModules();
    const { VALYU_API_BASE } = await import('../lib/client.js');
    expect(VALYU_API_BASE).toBe('https://example.test/v1');
  });
});
