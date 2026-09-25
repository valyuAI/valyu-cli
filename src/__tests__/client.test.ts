import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValyuClient, describeApiError } from '../lib/client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, status = 200) {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(json),
    body: null,
  };
}

describe('ValyuClient.search', () => {
  let client: ValyuClient;

  beforeEach(() => {
    client = new ValyuClient('test-api-key-1234567890');
    mockFetch.mockReset();
  });

  const sentBody = () => JSON.parse(mockFetch.mock.calls[0][1].body);

  it('sends correct headers and returns results', async () => {
    const mockData = {
      success: true,
      results: [{ title: 'Test', url: 'https://example.com', content: 'content', source: 'web' }],
      total_deduction_dollars: 0.001,
    };
    mockFetch.mockResolvedValueOnce(makeResponse(mockData));

    const { data, error } = await client.search({ query: 'test' });

    expect(error).toBeNull();
    expect(data?.results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.valyu.ai/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key-1234567890',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('sends an unscoped query with no search_type, so routing covers everything', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({ query: 'GLP-1 outcomes' });

    expect(sentBody()).toEqual({ query: 'GLP-1 outcomes', max_num_results: 10 });
  });

  it('passes scope, length and filters through by their API names', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({
      query: 'q',
      maxNumResults: 20,
      responseLength: 4000,
      includedSources: ['valyu/valyu-arxiv', 'web'],
      excludedSources: ['reddit.com'],
      sourceBiases: { 'arxiv.org': 3 },
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      countryCode: 'GB',
    });

    expect(sentBody()).toEqual({
      query: 'q',
      max_num_results: 20,
      response_length: 4000,
      included_sources: ['valyu/valyu-arxiv', 'web'],
      excluded_sources: ['reddit.com'],
      source_biases: { 'arxiv.org': 3 },
      start_date: '2026-01-01',
      end_date: '2026-06-30',
      country_code: 'GB',
    });
  });

  it('omits empty source lists', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({ query: 'q', includedSources: [], excludedSources: [], sourceBiases: {} });

    expect(sentBody()).toEqual({ query: 'q', max_num_results: 10 });
  });

  it('returns error on HTTP 401', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));

    const { data, error } = await client.search({ query: 'test' });

    expect(data).toBeNull();
    expect(error?.code).toBe('http_401');
    expect(error?.message).toContain('valyu login');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { data, error } = await client.search({ query: 'test' });

    expect(data).toBeNull();
    expect(error?.code).toBe('network_error');
    expect(error?.message).toContain('ECONNREFUSED');
  });
});

describe('describeApiError', () => {
  it('says a 402 will not clear on retry', () => {
    const err = describeApiError(402, { error: 'Insufficient credits' });
    expect(err.code).toBe('http_402');
    expect(err.message).toMatch(/^Insufficient credits\n\n/);
    expect(err.message).toContain('retrying will fail');
  });

  it('points a tier_insufficient 403 at an unscoped search', () => {
    const err = describeApiError(403, { error: 'Your current plan does not include access to: x', code: 'tier_insufficient' });
    expect(err.message).toContain('Retry without --include-source');
  });

  it('names sources search cannot reach', () => {
    const err = describeApiError(403, { error: 'Restricted', restricted_sources: ['valyu/valyu-npi-registry'] });
    expect(err.message).toContain('valyu/valyu-npi-registry');
  });

  it('leaves a 403 limit message alone rather than blaming the key', () => {
    const err = describeApiError(403, { error: 'Must be between 1 and 20. Contact Valyu for higher limits.' });
    expect(err.message).toBe('Must be between 1 and 20. Contact Valyu for higher limits.');
  });

  it('treats a bare Forbidden as a rejected key', () => {
    expect(describeApiError(403, { message: 'Forbidden' }).message).toContain('valyu login');
  });

  it('falls back to the status line for a non-JSON body', () => {
    expect(describeApiError(502, null, 'Bad Gateway').message).toMatch(/^HTTP 502: Bad Gateway\n\n.*retry once/);
  });
});

describe('ValyuClient.contents', () => {
  let client: ValyuClient;

  beforeEach(() => {
    client = new ValyuClient('test-key-1234567890');
    mockFetch.mockReset();
  });

  it('sends correct payload for URL extraction', async () => {
    const mockData = {
      success: true,
      results: [{ url: 'https://example.com', content: 'Page content', length: 100 }],
      urls_requested: 1,
      urls_processed: 1,
      urls_failed: 0,
    };
    mockFetch.mockResolvedValueOnce(makeResponse(mockData));

    const { data, error } = await client.contents({ urls: ['https://example.com'], responseLength: 30000 });

    expect(error).toBeNull();
    expect(data?.urls_processed).toBe(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      urls: ['https://example.com'],
      response_length: 30000,
      extract_effort: 'auto',
    });
  });

  it('passes a summary instruction as the summary itself', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [], urls_requested: 1, urls_processed: 1, urls_failed: 0 }));

    await client.contents({ urls: ['https://example.com'], summary: 'Extract key findings', screenshot: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.summary).toBe('Extract key findings');
    expect(body.screenshot).toBe(true);
  });
});

describe('ValyuClient.createResearch', () => {
  let client: ValyuClient;

  beforeEach(() => {
    client = new ValyuClient('test-key-1234567890');
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(makeResponse({ deepresearch_id: 'dr_1', status: 'queued' }));
  });

  const sentBody = () => JSON.parse(mockFetch.mock.calls[0][1].body);

  it('sends only what was asked for, with scoping under `search`', async () => {
    await client.createResearch({
      query: 'brief',
      mode: 'fast',
      search: { includedSources: ['valyu/valyu-pubmed'], startDate: '2025-01-01' },
    });
    expect(sentBody()).toEqual({
      query: 'brief',
      mode: 'fast',
      search: { included_sources: ['valyu/valyu-pubmed'], start_date: '2025-01-01' },
    });
  });

  it('runs a workflow without a query or a forced mode', async () => {
    await client.createResearch({ workflowId: 'ib-company-profile', workflowParams: { company: 'NVIDIA' } });
    expect(sentBody()).toEqual({ workflow_id: 'ib-company-profile', workflow_params: { company: 'NVIDIA' } });
  });
});

describe('ValyuClient workflows', () => {
  let client: ValyuClient;

  beforeEach(() => {
    client = new ValyuClient('test-key-1234567890');
    mockFetch.mockReset();
  });

  it('listWorkflows builds query string from filters', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ workflows: [], total: 0, next_cursor: null, verticals: [] }),
    );

    await client.listWorkflows({
      vertical: 'investment-banking',
      scope: 'valyu',
      query: 'company profile',
      tags: ['ib', 'profile'],
      limit: 25,
      expand: true,
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/v1/workflows?');
    expect(url).toContain('vertical=investment-banking');
    expect(url).toContain('scope=valyu');
    expect(url).toContain('q=company+profile');
    expect(url).toContain('tags=ib%2Cprofile');
    expect(url).toContain('limit=25');
    expect(url).toContain('expand=true');
  });

  it('getWorkflow appends version query when provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ slug: 'ib-company-profile', version: 2 }));

    await client.getWorkflow('ib-company-profile', 2);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/v1/workflows/ib-company-profile?');
    expect(url).toContain('version=2');
  });

  it('getWorkflow url-encodes org-prefixed slugs', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ slug: 'my-org/flow', version: 1 }));

    await client.getWorkflow('my-org/flow');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/v1/workflows/my-org%2Fflow');
  });

  it('previewWorkflow posts workflow_params and version', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({ workflow: { slug: 's', version: 1 }, resolved: {}, estimated_credits: null }),
    );

    await client.previewWorkflow('ib-company-profile', { company: 'NVIDIA' }, 1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.valyu.ai/v1/workflows/ib-company-profile/preview');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.workflow_params).toEqual({ company: 'NVIDIA' });
    expect(body.workflow_version).toBe(1);
  });

  it('runWorkflow sends workflow_id and only includes provided overrides', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ deepresearch_id: 'dr_1', status: 'running' }));

    await client.runWorkflow({
      slug: 'ib-company-profile',
      workflowParams: { company: 'Stripe' },
      mode: 'fast',
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.valyu.ai/v1/deepresearch/tasks');
    const body = JSON.parse(init.body);
    expect(body.workflow_id).toBe('ib-company-profile');
    expect(body.workflow_params).toEqual({ company: 'Stripe' });
    expect(body.mode).toBe('fast');
    // No params beyond what was passed; version/webhook left undefined and stripped
    expect('workflow_version' in body).toBe(false);
    expect('webhook_url' in body).toBe(false);
  });

  it('runWorkflow omits empty workflow_params so the template applies', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ deepresearch_id: 'dr_1', status: 'running' }));

    await client.runWorkflow({ slug: 'ib-company-profile', workflowParams: {} });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workflow_id).toBe('ib-company-profile');
    expect('workflow_params' in body).toBe(false);
    expect('mode' in body).toBe(false);
  });

  it('updateWorkflow uses the PATCH method', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ slug: 'my-flow', version: 2 }));

    await client.updateWorkflow('my-flow', { version: { changelog: 'tweak' } });

    const init = mockFetch.mock.calls[0][1];
    expect(init.method).toBe('PATCH');
  });

  it('deleteWorkflow uses the DELETE method', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ slug: 'my-flow', deleted_at: 'now' }));

    await client.deleteWorkflow('my-flow');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.valyu.ai/v1/workflows/my-flow');
    expect(init.method).toBe('DELETE');
  });
});

describe('ValyuClient.validateKey', () => {
  let client: ValyuClient;

  beforeEach(() => {
    client = new ValyuClient('test-key-1234567890');
    mockFetch.mockReset();
  });

  it('returns valid:true on successful response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    const result = await client.validateKey();
    expect(result.valid).toBe(true);
  });

  it('returns valid:false on 401', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));

    const result = await client.validateKey();
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns valid:true on rate limit (key is recognized)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Rate limited' }, 429));

    const result = await client.validateKey();
    expect(result.valid).toBe(true);
  });
});
