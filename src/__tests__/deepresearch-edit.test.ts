import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValyuClient } from '../lib/client.js';
import { editExitCode, editFocus, editPollDelayMs } from '../lib/deepresearch.js';
import { isRootVersionRequest } from '../lib/parsers.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  };
}

describe('ValyuClient report editing', () => {
  let client: ValyuClient;

  beforeEach(() => {
    client = new ValyuClient('test-api-key-1234567890');
    mockFetch.mockReset();
  });

  // The edit endpoint rejects unknown or null fields with a 400, and the
  // idempotency key must travel as a header, never in the body.
  it('sends only the fields that were set, with the idempotency key as a header', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        { edit_id: 'ed_1', deepresearch_id: 'abc', status: 'running', retry_after_seconds: 3 },
        202,
      ),
    );
    const { data, error } = await client.editResearch('abc', {
      instruction: 'Cut the summary to 3 bullets',
      focus: { section: 'Executive Summary', scope: 'strict' },
      waitSeconds: 20,
      idempotencyKey: 'key-1',
    });

    expect(error).toBeNull();
    expect(data?.status).toBe('running');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.valyu.ai/v1/deepresearch/tasks/abc/edit');
    expect(init.headers['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(init.body)).toEqual({
      instruction: 'Cut the summary to 3 bullets',
      focus: { section: 'Executive Summary', scope: 'strict' },
      wait_seconds: 20,
    });
  });

  it('reads a specific version through the status query string', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ status: 'completed', version: 1, is_latest: false }),
    );
    await client.getResearchStatus('abc', 1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.valyu.ai/v1/deepresearch/tasks/abc/status?version=1',
    );
  });

  // Agents branch on these codes (retry later vs. fix the focus), so they must
  // not be flattened to http_409 / http_422.
  it('keeps the API error code and the focus candidates', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        {
          error: 'The passage appears more than once',
          code: 'focus.ambiguous',
          candidates: [{ start_char: 10, end_char: 20, section: 'Outlook' }],
        },
        422,
      ),
    );
    const { error } = await client.editResearch('abc', { instruction: 'x', focus: { text: 'y' } });
    expect(error?.code).toBe('focus.ambiguous');
    expect(error?.message).toBe('The passage appears more than once');
    expect(error?.candidates).toHaveLength(1);
  });

  it('still reports http_<status> when the body has no namespaced code', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Not found' }, 404));
    const { error } = await client.listResearchVersions('abc');
    expect(error?.code).toBe('http_404');
  });
});

describe('editFocus', () => {
  it('leaves focus out entirely when no focus flag is given', () => {
    expect(editFocus({})).toBeUndefined();
  });

  it('maps flags to focus fields and --strict to scope', () => {
    expect(
      editFocus({
        section: 'Outlook',
        text: 'Margins expand.',
        startChar: '5',
        endChar: '20',
        strict: true,
      }),
    ).toEqual({
      section: 'Outlook',
      text: 'Margins expand.',
      start_char: 5,
      end_char: 20,
      scope: 'strict',
    });
  });

  it('rejects an unpaired or inverted offset range and --strict with nothing to focus on', () => {
    expect(() => editFocus({ startChar: '5' })).toThrow(/together/);
    expect(() => editFocus({ startChar: '20', endChar: '5' })).toThrow(/greater/);
    expect(() => editFocus({ strict: true })).toThrow(/--strict/);
  });
});

describe('editExitCode', () => {
  it('treats applied and no-change as success, other declines as 2 and failures as 1', () => {
    expect(editExitCode({ status: 'applied' })).toBe(0);
    expect(
      editExitCode({ status: 'declined', decline: { code: 'edit.no_change', message: '' } }),
    ).toBe(0);
    expect(
      editExitCode({ status: 'declined', decline: { code: 'edit.out_of_evidence', message: '' } }),
    ).toBe(2);
    expect(editExitCode({ status: 'failed' })).toBe(1);
  });
});

describe('editPollDelayMs', () => {
  it('follows retry_after_seconds within bounds and defaults to 3 s', () => {
    expect(editPollDelayMs({ retry_after_seconds: 5 })).toBe(5000);
    expect(editPollDelayMs({ retry_after_seconds: 600 })).toBe(30000);
    expect(editPollDelayMs({})).toBe(3000);
  });
});

// `--version` after a subcommand belongs to that subcommand; before one it
// prints the CLI version.
describe('isRootVersionRequest', () => {
  it('only claims --version before the subcommand', () => {
    expect(isRootVersionRequest(['--version'])).toBe(true);
    expect(isRootVersionRequest(['-p', 'work', '-v'])).toBe(true);
    expect(isRootVersionRequest(['deepresearch', 'status', 'abc', '--version', '2'])).toBe(false);
    expect(isRootVersionRequest(['workflows', 'get', 'slug', '--version', '2'])).toBe(false);
  });
});
