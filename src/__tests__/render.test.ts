import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderSearchResults, renderAnswer, renderContents } from '../lib/render.js';
import type { SearchResultItem, AnswerResult, ContentsItem } from '../lib/client.js';

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
      renderSearchResults(results, { query: 'test', searchType: 'web' }),
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
      renderSearchResults(results, { query: 'AAPL', searchType: 'finance' }),
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
      renderSearchResults(results, { query: 'AAPL financials', searchType: 'finance' }),
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
      renderSearchResults(results, { query: 'test', searchType: 'web' }),
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
      renderSearchResults(results, { query: 'test', searchType: 'web' }),
    ).not.toThrow();
  });

  it('handles empty results array', () => {
    expect(() =>
      renderSearchResults([], { query: 'test', searchType: 'web' }),
    ).not.toThrow();
  });

  it('shows cost when provided', () => {
    renderSearchResults([], { query: 'test', searchType: 'web', cost: 0.0042 });
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(calls).toContain('0.0042');
  });

  it('does nothing in quiet mode', () => {
    renderSearchResults([], { query: 'test', searchType: 'web', quiet: true });
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe('renderAnswer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an answer result', () => {
    const result: AnswerResult = {
      answer: 'The answer is 42.',
      sources: [{ title: 'Wikipedia', url: 'https://en.wikipedia.org' }],
      total_deduction_dollars: 0.003,
    };
    expect(() => renderAnswer(result, {})).not.toThrow();
  });

  it('uses output field when answer is absent', () => {
    const result: AnswerResult = {
      output: 'Alternative output field.',
    };
    expect(() => renderAnswer(result, {})).not.toThrow();
  });

  it('does nothing in quiet mode', () => {
    renderAnswer({ answer: 'test' }, { quiet: true });
    expect(console.log).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
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
