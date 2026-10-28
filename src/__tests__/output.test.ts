import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outputError, printWarnings, warningMessages } from '../lib/output.js';

describe('outputError', () => {
  let logs: string[];
  let exitCode: number | undefined;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    logs = [];
    exitCode = undefined;
    // Human-mode tests need a TTY stdout; outputError treats a non-TTY as
    // "machine consumer" and forces JSON regardless of the `json` option.
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      logs.push(msg);
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('adds the new rate-limit fields to JSON output without dropping message/code', () => {
    outputError(
      {
        message: 'Search rate limit reached: your Pay-as-you-go plan allows 5 requests per second.',
        code: 'http_429',
        retryAfter: 2,
        plan: 'Pay-as-you-go',
        limit: { endpoint: 'search', requests_per_second: 5 },
        upgradeUrl: 'https://platform.valyu.ai/user/account/billing?tab=plan',
      },
      { json: true },
    );

    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.error.message).toMatch(/^Search rate limit reached/);
    expect(parsed.error.code).toBe('http_429');
    expect(parsed.error.retry_after).toBe(2);
    expect(parsed.error.plan).toBe('Pay-as-you-go');
    expect(parsed.error.limit).toEqual({
      endpoint: 'search',
      requests_per_second: 5,
    });
    expect(parsed.error.upgrade_url).toBe(
      'https://platform.valyu.ai/user/account/billing?tab=plan',
    );
    expect(parsed.error.contact_url).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  it('keeps JSON output unchanged (no new fields) when the error carries none', () => {
    outputError({ message: 'No API key found.', code: 'not_authenticated' }, { json: true });

    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed).toEqual({
      error: { message: 'No API key found.', code: 'not_authenticated' },
    });
  });

  it('prints an Upgrade line in human mode when upgradeUrl is set', () => {
    outputError(
      {
        message: 'Search rate limit reached.',
        code: 'http_429',
        upgradeUrl: 'https://platform.valyu.ai/user/account/billing?tab=plan',
      },
      { json: false },
    );

    const text = logs.join('\n');
    expect(text).toMatch(/Upgrade:.*platform\.valyu\.ai/);
    expect(text).not.toMatch(/Contact:/);
    expect(text.toLowerCase()).not.toMatch(/billing problem|credit/);
  });

  it('prints a Contact line in human mode when only contactUrl is set', () => {
    outputError(
      {
        message: 'Search rate limit reached.',
        code: 'http_429',
        contactUrl: 'https://www.valyu.ai/contact',
      },
      { json: false },
    );

    const text = logs.join('\n');
    expect(text).toMatch(/Contact:.*valyu\.ai\/contact/);
    expect(text).not.toMatch(/Upgrade:/);
  });

  it('prints neither link line when the error carries no rate-limit detail', () => {
    outputError({ message: 'No API key found.', code: 'not_authenticated' }, { json: false });

    const text = logs.join('\n');
    expect(text).not.toMatch(/Upgrade:|Contact:/);
  });
});

describe('warnings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads messages from objects and plain strings, skipping anything else', () => {
    expect(
      warningMessages([
        { type: 'datasets_not_in_plan', message: 'valyu/valyu-biorxiv was skipped.', detail: {} },
        'Collection \'nope\' not found',
        { type: 'no_message' },
        null,
        42,
      ]),
    ).toEqual(['valyu/valyu-biorxiv was skipped.', "Collection 'nope' not found"]);
    expect(warningMessages(undefined)).toEqual([]);
    expect(warningMessages({ message: 'not a list' })).toEqual([]);
  });

  it('prints one Warning line per message on stderr', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });
    const log = vi.spyOn(console, 'log');

    printWarnings([{ type: 'max_num_results_capped', message: 'max_num_results was capped at 20.' }]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Warning:.* max_num_results was capped at 20\.$/);
    expect(log).not.toHaveBeenCalled();
  });
});
