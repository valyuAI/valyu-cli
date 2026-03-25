import { resolveApiKey, type ResolvedKey } from './config.js';
import { outputError } from './output.js';
import { VERSION } from './version.js';

export const VALYU_API_BASE = 'https://api.valyu.ai/v1';
export const PLATFORM_URL = 'https://platform.valyu.ai';
export const DOCS_URL = 'https://docs.valyu.ai';

export interface GlobalOpts {
  apiKey?: string;
  json?: boolean;
  quiet?: boolean;
  profile?: string;
}

export function requireApiKey(globalOpts: GlobalOpts): ResolvedKey {
  const resolved = resolveApiKey(globalOpts.apiKey, globalOpts.profile);
  if (!resolved) {
    outputError(
      {
        message:
          'No API key found. Run `valyu login` to authenticate, or set VALYU_API_KEY.',
        code: 'not_authenticated',
      },
      { json: globalOpts.json },
    );
  }
  return resolved;
}

// Search type to API params mapping
const SEARCH_TYPE_CONFIGS: Record<
  string,
  { search_type: string; included_sources?: string[] }
> = {
  web: { search_type: 'web' },
  news: { search_type: 'news' },
  paper: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-arxiv',
      'valyu/valyu-biorxiv',
      'valyu/valyu-medrxiv',
      'valyu/valyu-pubmed',
    ],
  },
  bio: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-pubmed',
      'valyu/valyu-biorxiv',
      'valyu/valyu-medrxiv',
      'valyu/valyu-clinical-trials',
      'valyu/valyu-drug-labels',
    ],
  },
  finance: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-stocks',
      'valyu/valyu-sec-filings',
      'valyu/valyu-earnings-US',
      'valyu/valyu-balance-sheet-US',
      'valyu/valyu-income-statement-US',
      'valyu/valyu-cash-flow-US',
      'valyu/valyu-dividends-US',
      'valyu/valyu-insider-transactions-US',
      'valyu/valyu-crypto',
      'valyu/valyu-forex',
    ],
  },
  sec: {
    search_type: 'proprietary',
    included_sources: ['valyu/valyu-sec-filings'],
  },
  patent: {
    search_type: 'proprietary',
    included_sources: ['valyu/valyu-patents'],
  },
  economics: {
    search_type: 'proprietary',
    included_sources: [
      'valyu/valyu-bls',
      'valyu/valyu-fred',
      'valyu/valyu-world-bank',
      'valyu/valyu-worldbank-indicators',
      'valyu/valyu-usaspending',
    ],
  },
};

export interface ValyuApiError {
  message: string;
  code?: string;
}

export class ValyuClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async get<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ data: T | null; error: ValyuApiError | null }> {
    try {
      const url = new URL(`${VALYU_API_BASE}${path}`);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined) url.searchParams.set(k, v);
        }
      }
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'User-Agent': `valyu-cli/${VERSION}`,
        },
      });

      if (!res.ok) {
        let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
        try {
          const errBody = (await res.json()) as { error?: string; message?: string };
          errorMsg = errBody.error ?? errBody.message ?? errorMsg;
        } catch { /* keep default */ }
        return { data: null, error: { message: errorMsg, code: `http_${res.status}` } };
      }

      const data = (await res.json()) as T;
      return { data, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { data: null, error: { message, code: 'network_error' } };
    }
  }

  private async del<T>(
    path: string,
  ): Promise<{ data: T | null; error: ValyuApiError | null }> {
    try {
      const res = await fetch(`${VALYU_API_BASE}${path}`, {
        method: 'DELETE',
        headers: {
          'x-api-key': this.apiKey,
          'User-Agent': `valyu-cli/${VERSION}`,
        },
      });

      if (!res.ok) {
        let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
        try {
          const errBody = (await res.json()) as { error?: string; message?: string };
          errorMsg = errBody.error ?? errBody.message ?? errorMsg;
        } catch { /* keep default */ }
        return { data: null, error: { message: errorMsg, code: `http_${res.status}` } };
      }

      const data = (await res.json()) as T;
      return { data, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { data: null, error: { message, code: 'network_error' } };
    }
  }

  private async request<T>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ data: T | null; error: ValyuApiError | null }> {
    // Strip undefined values
    const body = Object.fromEntries(
      Object.entries(payload).filter(([, v]) => v !== undefined),
    );

    try {
      const res = await fetch(`${VALYU_API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'User-Agent': `valyu-cli/${VERSION}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
        try {
          const errBody = (await res.json()) as { error?: string; message?: string };
          errorMsg = errBody.error ?? errBody.message ?? errorMsg;
        } catch {
          // keep default
        }
        return { data: null, error: { message: errorMsg, code: `http_${res.status}` } };
      }

      const data = (await res.json()) as T;
      return { data, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { data: null, error: { message, code: 'network_error' } };
    }
  }

  async validateKey(): Promise<{ valid: boolean; error?: string }> {
    const { error } = await this.request('/search', {
      query: 'test',
      search_type: 'web',
      max_num_results: 1,
    });
    if (error) {
      if (error.code === 'http_401' || error.code === 'http_403') {
        return { valid: false, error: 'Invalid or unauthorized API key' };
      }
      // Rate limit, etc. still means the key is recognized
      return { valid: true };
    }
    return { valid: true };
  }

  async search(params: {
    query: string;
    searchType: string;
    maxNumResults?: number;
    maxPrice?: number;
  }): Promise<{ data: SearchResult | null; error: ValyuApiError | null }> {
    const config = SEARCH_TYPE_CONFIGS[params.searchType] ?? { search_type: 'web' };

    const payload: Record<string, unknown> = {
      query: params.query,
      max_num_results: params.maxNumResults ?? 10,
      data_max_price: params.maxPrice ?? 40.0,
      ...config,
    };

    return this.request<SearchResult>('/search', payload);
  }

  async *streamAnswer(params: {
    query: string;
    fastMode?: boolean;
  }): AsyncGenerator<AnswerChunk> {
    const payload = {
      query: params.query,
      search_type: 'all',
      data_max_price: 40.0,
      ...(params.fastMode ? { fast_mode: true } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${VALYU_API_BASE}/answer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          Accept: 'text/event-stream',
          'User-Agent': `valyu-cli/${VERSION}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : 'Network error' };
      return;
    }

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
      try {
        const e = (await res.json()) as { error?: string; message?: string };
        errorMsg = e.error ?? e.message ?? errorMsg;
      } catch { /* keep default */ }
      yield { type: 'error', error: errorMsg };
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') { yield { type: 'done' }; continue; }

        try {
          const parsed = JSON.parse(dataStr) as Record<string, unknown>;

          if (Array.isArray(parsed.search_results) && !('success' in parsed)) {
            yield { type: 'search_results', searchResults: parsed.search_results as AnswerSource[] };
          } else if (parsed.choices) {
            const delta = (parsed.choices as Array<{ delta?: { content?: string } }>)[0]?.delta;
            if (delta?.content) yield { type: 'content', content: delta.content };
          } else if ('success' in parsed) {
            const cost = parsed.cost as Record<string, number> | undefined;
            yield {
              type: 'metadata',
              cost: cost?.total_deduction_dollars,
              contents: parsed.contents as string | undefined,
            };
          }
        } catch { continue; }
      }
    }
  }

  async contents(params: {
    urls: string[];
    summary?: boolean;
    summaryInstructions?: string;
    responseLength?: string;
    structuredOutput?: Record<string, unknown>;
  }): Promise<{ data: ContentsResult | null; error: ValyuApiError | null }> {
    return this.request<ContentsResult>('/contents', {
      urls: params.urls,
      response_length: params.responseLength ?? 'medium',
      extract_effort: 'auto',
      summary: params.summaryInstructions ?? params.summary ?? false,
      structured_output: params.structuredOutput,
      max_price_dollars: 0.5,
    });
  }

  async createResearch(params: {
    query: string;
    mode?: string;
    outputFormats?: string[];
    deliverables?: string[];
  }): Promise<{ data: ResearchTask | null; error: ValyuApiError | null }> {
    const body: Record<string, unknown> = {
      query: params.query,
      mode: params.mode ?? 'fast',
      output_formats: params.outputFormats ?? ['markdown', 'pdf'],
    };
    if (params.deliverables?.length) {
      body.deliverables = params.deliverables;
    }
    return this.request<ResearchTask>('/deepresearch/tasks', body);
  }

  async getResearchStatus(
    id: string,
  ): Promise<{ data: ResearchStatus | null; error: ValyuApiError | null }> {
    return this.get<ResearchStatus>(`/deepresearch/tasks/${id}/status`);
  }

  async listResearch(
    limit?: number,
  ): Promise<{ data: ResearchListResult | null; error: ValyuApiError | null }> {
    return this.get<ResearchListResult>(
      '/deepresearch/list',
      limit ? { limit: String(limit) } : undefined,
    );
  }

  async cancelResearch(
    id: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/tasks/${id}/cancel`, {});
  }

  async respondResearch(
    id: string,
    interactionId: string,
    response: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/tasks/${id}/respond`, {
      interaction_id: interactionId,
      response,
    });
  }

  async updateResearch(
    id: string,
    instruction: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/tasks/${id}/update`, {
      instruction,
    });
  }

  async deleteResearch(
    id: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.del<Record<string, unknown>>(`/deepresearch/tasks/${id}/delete`);
  }

  async toggleResearchPublic(
    id: string,
    isPublic: boolean,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/tasks/${id}/public`, {
      public: isPublic,
    });
  }

  // ─── Contents async jobs ──────────────────────────────────────────────────

  async getContentsJob(
    jobId: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.get<Record<string, unknown>>(`/contents/jobs/${jobId}`);
  }

  // ─── DeepResearch Batch ───────────────────────────────────────────────────

  async createBatch(params: {
    queries: string[];
    mode?: string;
    outputFormats?: string[];
  }): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>('/deepresearch/batches', {
      queries: params.queries,
      mode: params.mode ?? 'standard',
      output_formats: params.outputFormats ?? ['markdown', 'pdf'],
    });
  }

  async listBatches(): Promise<{ data: Record<string, unknown>[] | null; error: ValyuApiError | null }> {
    return this.get<Record<string, unknown>[]>('/deepresearch/batches');
  }

  async getBatchStatus(
    id: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.get<Record<string, unknown>>(`/deepresearch/batches/${id}`);
  }

  async addBatchTasks(
    id: string,
    queries: string[],
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/batches/${id}/tasks`, { queries });
  }

  async listBatchTasks(
    id: string,
  ): Promise<{ data: Record<string, unknown>[] | null; error: ValyuApiError | null }> {
    return this.get<Record<string, unknown>[]>(`/deepresearch/batches/${id}/tasks`);
  }

  async cancelBatch(
    id: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/batches/${id}/cancel`, {});
  }

  async listDatasources(
    category?: string,
  ): Promise<{ data: DatasourcesResult | null; error: ValyuApiError | null }> {
    return this.get<DatasourcesResult>(
      '/datasources',
      category ? { category } : undefined,
    );
  }

  async listDatasourceCategories(): Promise<{
    data: DatasourceCategoriesResult | null;
    error: ValyuApiError | null;
  }> {
    return this.get<DatasourceCategoriesResult>('/datasources/categories');
  }
}

// Streaming answer types
export interface AnswerSource {
  title: string;
  url: string;
}

export type AnswerChunk =
  | { type: 'search_results'; searchResults: AnswerSource[] }
  | { type: 'content'; content: string }
  | { type: 'metadata'; cost?: number; contents?: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

// Response types
export interface SearchResultItem {
  title: string;
  url: string;
  content: unknown; // string for web/paper, number for prices, array for structured data
  source: string;
  relevance_score?: number;
}

export interface SearchResult {
  success?: boolean;
  results: SearchResultItem[];
  total_results?: number;
  results_by_source?: Record<string, number>;
  query?: string;
  total_deduction_dollars?: number;
}

export interface AnswerResult {
  success?: boolean;
  answer?: string;
  output?: string;
  sources?: Array<{ title: string; url: string }>;
  data_type?: string;
  total_deduction_dollars?: number;
}

export interface ContentsItem {
  title?: string;
  url: string;
  content: string;
  summary?: string;
  length?: number;
  data_type?: string;
  error?: string;
}

export interface ContentsResult {
  success?: boolean;
  results: ContentsItem[];
  urls_requested: number;
  urls_processed: number;
  urls_failed: number;
  total_cost?: number;
}

export interface ResearchTask {
  deepresearch_id?: string;
  id?: string;
  task_id?: string;
  status: string;
  query?: string;
  input?: string;
  mode?: string;
  model?: string;
  created_at?: string | number;
  public?: boolean;
}

export interface ResearchStatus {
  deepresearch_id?: string;
  id?: string;
  task_id?: string;
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'paused';
  query?: string;
  input?: string;
  mode?: string;
  output?: string;
  output_type?: string;
  pdf_url?: string;
  images?: Array<{ image_id: string; title: string; image_url: string }>;
  deliverables?: Array<{
    id: string;
    type: string;
    status: string;
    title: string;
    url: string;
    error?: string;
  }>;
  sources?: Array<{
    title: string;
    url: string;
    snippet?: string;
    source?: string;
  }>;
  progress?: { current_step: number; total_steps: number };
  interaction?: {
    interaction_id: string;
    type: 'planning_questions' | 'plan_review' | 'source_review' | 'outline_review';
    data: Record<string, unknown>;
  };
  cost?: number;
  usage?: { search_cost: number; ai_cost: number; total_cost: number };
  created_at?: string | number;
  completed_at?: string | number;
  error?: string;
  public?: boolean;
}

export interface ResearchListItem {
  deepresearch_id: string;
  query: string;
  status: string;
  created_at: number | string;
  public: boolean;
}

// List response can be a direct array or wrapped in {data: [...]}
export type ResearchListResult = ResearchListItem[] | { success: boolean; data: ResearchListItem[] };

export interface Datasource {
  id: string;
  name: string;
  description: string;
  category: string;
  type: string;
  topics: string[];
  example_queries: string[];
  pricing: { cpm: number };
  update_frequency?: string;
  size?: number;
  coverage?: { start_date?: string | null; end_date?: string | null };
}

export interface DatasourceCategory {
  id: string;
  name: string;
  description: string;
  dataset_count: number;
}

export interface DatasourcesResult {
  datasources: Datasource[];
}

export interface DatasourceCategoriesResult {
  categories: DatasourceCategory[];
}
