import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValyuClient } from '../lib/client.js';

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

  it('sends correct headers and returns results', async () => {
    const mockData = {
      success: true,
      results: [{ title: 'Test', url: 'https://example.com', content: 'content', source: 'web' }],
      total_deduction_dollars: 0.001,
    };
    mockFetch.mockResolvedValueOnce(makeResponse(mockData));

    const { data, error } = await client.search({ query: 'test', searchType: 'web' });

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

  it('maps finance type to proprietary with correct sources', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({ query: 'AAPL', searchType: 'finance' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.search_type).toBe('proprietary');
    expect(body.included_sources).toContain('valyu/valyu-stocks');
    expect(body.included_sources).toContain('valyu/valyu-sec-filings');
  });

  it('maps web type correctly', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({ query: 'news', searchType: 'web' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.search_type).toBe('web');
    expect(body.included_sources).toBeUndefined();
  });

  it('maps paper type to proprietary academic sources', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({ query: 'CRISPR', searchType: 'paper' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.search_type).toBe('proprietary');
    expect(body.included_sources).toContain('valyu/valyu-arxiv');
    expect(body.included_sources).toContain('valyu/valyu-pubmed');
  });

  it('returns error on HTTP 401', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));

    const { data, error } = await client.search({ query: 'test', searchType: 'web' });

    expect(data).toBeNull();
    expect(error?.code).toBe('http_401');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { data, error } = await client.search({ query: 'test', searchType: 'web' });

    expect(data).toBeNull();
    expect(error?.code).toBe('network_error');
    expect(error?.message).toContain('ECONNREFUSED');
  });

  it('strips undefined values from payload', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [] }));

    await client.search({ query: 'test', searchType: 'web', maxPrice: undefined });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // data_max_price is always included (has default), but no undefined keys
    expect(Object.values(body).every((v) => v !== undefined)).toBe(true);
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

    const { data, error } = await client.contents({ urls: ['https://example.com'] });

    expect(error).toBeNull();
    expect(data?.urls_processed).toBe(1);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.urls).toEqual(['https://example.com']);
    // summary is omitted entirely when not requested (undefined stripped by request())
    expect(body.summary).toBeUndefined();
  });

  it('includes summary instructions when provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ success: true, results: [], urls_requested: 1, urls_processed: 1, urls_failed: 0 }));

    await client.contents({
      urls: ['https://example.com'],
      summary: true,
      summaryInstructions: 'Extract key findings',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.summary).toBe('Extract key findings');
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
