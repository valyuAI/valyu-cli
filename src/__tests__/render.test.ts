import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clipResults, clipText, renderSearchResults, renderContents } from '../lib/render.js';
import type { SearchResultItem, ContentsItem } from '../lib/client.js';

describe('renderSearchResults', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles string content (web results)', () => {
    const results: SearchResultItem[] = [
      {
        title: 'Test Article',
        url: 'https://example.com',
        content: 'This is web content',
        source: 'web',
        relevance_score: 0.95,
      },
    ];
    expect(() =>
      renderSearchResults(results, { query: 'test' }),
    ).not.toThrow();
    expect(console.log).toHaveBeenCalled();
  });

  it('handles number content (stock prices)', () => {
    const results: SearchResultItem[] = [
      {
        title: 'Current price of AAPL',
        url: 'https://platform.valyu.ai',
        content: 248.19,
        source: 'valyu/valyu-stocks',
        relevance_score: 0.88,
      },
    ];
    expect(() =>
      renderSearchResults(results, { query: 'AAPL' }),
    ).not.toThrow();
  });

  it('handles array content (income statements)', () => {
    const results: SearchResultItem[] = [
      {
        title: 'AAPL Income Statement (Quarterly)',
        url: 'https://platform.valyu.ai',
        content: [
          {
            fiscal_date: '2025-12-31',
            sales: 143756000000,
            net_income: 42097000000,
            eps_basic: 2.85,
          },
          {
            fiscal_date: '2025-09-30',
            sales: 102466000000,
            net_income: 27466000000,
            eps_basic: 1.85,
          },
          {
            fiscal_date: '2025-06-30',
            sales: 94036000000,
            net_income: 23434000000,
            eps_basic: 1.57,
          },
          {
            fiscal_date: '2025-03-31',
            sales: 95359000000,
            net_income: 24780000000,
            eps_basic: 1.65,
          },
        ],
        source: 'valyu/valyu-income-statement-US',
        relevance_score: 0.75,
      },
    ];
    expect(() =>
      renderSearchResults(results, { query: 'AAPL financials' }),
    ).not.toThrow();
  });

  it('handles null/undefined content', () => {
    const results: SearchResultItem[] = [
      {
        title: 'Empty Result',
        url: 'https://example.com',
        content: null,
        source: 'web',
      },
    ];
    expect(() =>
      renderSearchResults(results, { query: 'test' }),
    ).not.toThrow();
  });

  it('handles object content', () => {
    const results: SearchResultItem[] = [
      {
        title: 'Structured Data',
        url: 'https://example.com',
        content: { ticker: 'AAPL', price: 248, currency: 'USD' },
        source: 'web',
      },
    ];
    expect(() =>
      renderSearchResults(results, { query: 'test' }),
    ).not.toThrow();
  });

  it('handles empty results array', () => {
    expect(() =>
      renderSearchResults([], { query: 'test' }),
    ).not.toThrow();
  });

  it('shows cost when provided', () => {
    renderSearchResults([], { query: 'test', cost: 0.0042 });
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(calls).toContain('0.0042');
  });

  it('does nothing in quiet mode', () => {
    renderSearchResults([], { query: 'test', quiet: true });
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe('clipResults', () => {
  it('counts what it cuts and leaves structured records whole', () => {
    const trial = JSON.stringify({ nct_id: 'NCT0', brief_title: 'x'.repeat(50) });
    const { results, clipped } = clipResults(
      [
        { content: 'a'.repeat(20), data_type: 'unstructured' },
        { content: trial, data_type: 'structured' },
        { content: 'short' },
      ],
      10,
    );
    expect(clipped).toBe(1);
    expect(results[0].content).toBe('aaaaaaaaa…');
    expect(results[1].content).toBe(trial);
    expect(results[2].content).toBe('short');
  });
});

describe('clipText', () => {
  it('cuts long strings and marks them', () => {
    expect(clipText('abcdefghij', 5)).toEqual({ content: 'abcd…', clipped: true });
  });

  it('leaves short strings and structured records whole', () => {
    expect(clipText('abc', 5)).toEqual({ content: 'abc', clipped: false });
    const rows = [{ revenue: 1 }, { revenue: 2 }];
    expect(clipText(rows, 5)).toEqual({ content: rows, clipped: false });
  });
});

describe('renderContents', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders content items', () => {
    const items: ContentsItem[] = [
      {
        title: 'Test Page',
        url: 'https://example.com',
        content: 'Page content here',
        length: 1000,
      },
    ];
    expect(() => renderContents(items, {})).not.toThrow();
  });

  it('renders item with summary', () => {
    const items: ContentsItem[] = [
      {
        title: 'Test Page',
        url: 'https://example.com',
        content: 'Full page content',
        summary: 'Short summary of the page',
        length: 5000,
      },
    ];
    expect(() => renderContents(items, {})).not.toThrow();
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(calls).toContain('Short summary of the page');
  });

  it('renders failed items', () => {
    const items: ContentsItem[] = [
      {
        url: 'https://example.com',
        content: '',
        error: 'Connection refused',
      },
    ];
    expect(() => renderContents(items, {})).not.toThrow();
  });

  it('does nothing in quiet mode', () => {
    renderContents([{ url: 'https://x.com', content: 'test' }], { quiet: true });
    expect(console.log).not.toHaveBeenCalled();
  });
});
