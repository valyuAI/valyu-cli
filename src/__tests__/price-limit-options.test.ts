import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentsCommand } from '../commands/contents/index.js';
import { searchCommand } from '../commands/search/index.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

let errors: string[];

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ success: true, results: [], total_deduction_dollars: 0 }),
    headers: { get: () => null },
  });
  vi.stubEnv('VALYU_API_KEY', 'not-a-real-key');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    errors.push(String(msg));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function search(...args: string[]) {
  await searchCommand.parseAsync(['search', 'q', ...args], { from: 'user' });
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

async function rejects(run: Promise<unknown>, message: RegExp) {
  const exitCode = await run.then(
    () => 'request sent',
    (err) => (err instanceof Exit ? err.code : err),
  );
  expect(exitCode).toBe(1);
  expect(mockFetch).not.toHaveBeenCalled();
  expect(errors.join('\n')).toMatch(message);
}

describe('search --max-price', () => {
  it('sends a plain number as the cap', async () => {
    expect((await search('--max-price', '5')).max_price).toBe(5);
  });

  it('accepts a leading dollar sign instead of dropping the cap', async () => {
    expect((await search('--max-price', '$5')).max_price).toBe(5);
  });

  it('rejects a decimal comma instead of truncating 1,5 to 1', async () => {
    await rejects(search('--max-price', '1,5'), /--max-price must be a positive number.*1\.5/);
  });

  it('rejects text and zero', async () => {
    await rejects(search('--max-price', 'five'), /--max-price must be a positive number/);
    mockFetch.mockClear();
    await rejects(search('--max-price', '0'), /--max-price must be a positive number/);
  });
});

describe('search --limit', () => {
  it('sends a positive integer', async () => {
    expect((await search('-n', '3')).max_num_results).toBe(3);
  });

  it('rejects anything that is not a positive integer', async () => {
    for (const bad of ['abc', '1,5', '2.5', '0']) {
      mockFetch.mockClear();
      await rejects(search('-n', bad), /--limit must be a positive integer/);
    }
  });
});

describe('contents --max-price-dollars', () => {
  const contents = (value: string) =>
    contentsCommand.parseAsync(['https://example.com', '--max-price-dollars', value], {
      from: 'user',
    });

  it('accepts a leading dollar sign', async () => {
    await contents('$2');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).max_price_dollars).toBe(2);
  });

  it('rejects a decimal comma instead of truncating it', async () => {
    await rejects(contents('1,5'), /--max-price-dollars must be a positive number.*1\.5/);
  });
});
