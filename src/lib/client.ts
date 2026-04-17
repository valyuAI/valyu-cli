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

function buildSearchConfig(search: {
  searchType?: string;
  includedSources?: string[];
  excludedSources?: string[];
  sourceBiases?: Record<string, number>;
  countryCode?: string;
  startDate?: string;
  endDate?: string;
}): Record<string, unknown> | undefined {
  const entries: [string, unknown][] = [];
  if (search.searchType) entries.push(['search_type', search.searchType]);
  if (search.includedSources?.length) entries.push(['included_sources', search.includedSources]);
  if (search.excludedSources?.length) entries.push(['excluded_sources', search.excludedSources]);
  if (search.sourceBiases && Object.keys(search.sourceBiases).length > 0) {
    entries.push(['source_biases', search.sourceBiases]);
  }
  if (search.countryCode) entries.push(['country_code', search.countryCode]);
  if (search.startDate) entries.push(['start_date', search.startDate]);
  if (search.endDate) entries.push(['end_date', search.endDate]);
  return entries.length ? Object.fromEntries(entries) : undefined;
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
    relevanceThreshold?: number;
    includedSources?: string[];
    excludedSources?: string[];
    sourceBiases?: Record<string, number>;
    instructions?: string;
    responseLength?: string | number;
    startDate?: string;
    endDate?: string;
    countryCode?: string;
    fastMode?: boolean;
    urlOnly?: boolean;
    isToolCall?: boolean;
    searchTypeOverride?: string;
  }): Promise<{ data: SearchResult | null; error: ValyuApiError | null }> {
    const preset = SEARCH_TYPE_CONFIGS[params.searchType] ?? { search_type: 'web' };
    // User-supplied sources / search_type override the preset
    const search_type = params.searchTypeOverride ?? preset.search_type;
    const included_sources =
      params.includedSources?.length ? params.includedSources : preset.included_sources;

    const payload: Record<string, unknown> = {
      query: params.query,
      max_num_results: params.maxNumResults ?? 10,
      max_price: params.maxPrice,
      relevance_threshold: params.relevanceThreshold,
      search_type,
      included_sources,
      excluded_sources: params.excludedSources?.length ? params.excludedSources : undefined,
      source_biases:
        params.sourceBiases && Object.keys(params.sourceBiases).length
          ? params.sourceBiases
          : undefined,
      instructions: params.instructions,
      response_length: params.responseLength,
      start_date: params.startDate,
      end_date: params.endDate,
      country_code: params.countryCode,
      fast_mode: params.fastMode || undefined,
      url_only: params.urlOnly || undefined,
      is_tool_call: params.isToolCall,
    };

    return this.request<SearchResult>('/search', payload);
  }

  async *streamAnswer(params: {
    query: string;
    fastMode?: boolean;
    searchType?: string;
    includedSources?: string[];
    excludedSources?: string[];
    sourceBiases?: Record<string, number>;
    countryCode?: string;
    startDate?: string;
    endDate?: string;
    dataMaxPrice?: number;
    structuredOutput?: Record<string, unknown>;
    systemInstructions?: string;
  }): AsyncGenerator<AnswerChunk> {
    const payload: Record<string, unknown> = {
      query: params.query,
      search_type: params.searchType ?? 'all',
      data_max_price: params.dataMaxPrice ?? 1.0,
      included_sources: params.includedSources?.length ? params.includedSources : undefined,
      excluded_sources: params.excludedSources?.length ? params.excludedSources : undefined,
      source_biases:
        params.sourceBiases && Object.keys(params.sourceBiases).length
          ? params.sourceBiases
          : undefined,
      country_code: params.countryCode,
      start_date: params.startDate,
      end_date: params.endDate,
      structured_output: params.structuredOutput,
      system_instructions: params.systemInstructions,
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
    responseLength?: string | number;
    structuredOutput?: Record<string, unknown>;
    extractEffort?: 'auto' | 'normal' | 'high';
    screenshot?: boolean;
    async?: boolean;
    webhookUrl?: string;
    maxPriceDollars?: number;
  }): Promise<{ data: ContentsResult | null; error: ValyuApiError | null }> {
    // The `summary` field is overloaded: bool (basic AI summary), string (custom
    // AI summary instructions), or object (JSON schema for structured extraction).
    // JSON schema goes through `summary`, not a separate `structured_output` field.
    let summaryValue: unknown;
    if (params.structuredOutput) {
      summaryValue = params.structuredOutput;
    } else if (params.summaryInstructions) {
      summaryValue = params.summaryInstructions;
    } else if (params.summary === true) {
      summaryValue = true;
    }
    return this.request<ContentsResult>('/contents', {
      urls: params.urls,
      response_length: params.responseLength ?? 'medium',
      extract_effort: params.extractEffort ?? 'auto',
      summary: summaryValue,
      screenshot: params.screenshot || undefined,
      async: params.async || undefined,
      webhook_url: params.webhookUrl,
      max_price_dollars: params.maxPriceDollars,
    });
  }

  async createResearch(params: {
    query: string;
    mode?: string;
    outputFormats?: Array<string | Record<string, unknown>>;
    researchStrategy?: string;
    reportFormat?: string;
    search?: {
      searchType?: string;
      includedSources?: string[];
      excludedSources?: string[];
      sourceBiases?: Record<string, number>;
      countryCode?: string;
      startDate?: string;
      endDate?: string;
    };
    urls?: string[];
    files?: Array<{ data: string; filename: string; mediaType: string; context?: string }>;
    metadata?: Record<string, string | number | boolean>;
    tools?: { code_execution?: boolean; screenshots?: boolean; browser_use?: boolean };
    mcpServers?: Array<Record<string, unknown>>;
    previousReports?: string[];
    webhookUrl?: string;
    alertEmail?: string | { email: string; custom_url?: string };
    deliverables?: Array<string | Record<string, unknown>>;
    hitl?: {
      planning_questions?: boolean;
      plan_review?: boolean;
      source_review?: boolean;
      outline_review?: boolean;
    };
  }): Promise<{ data: ResearchTask | null; error: ValyuApiError | null }> {
    const search = params.search && buildSearchConfig(params.search);
    const body: Record<string, unknown> = {
      query: params.query,
      mode: params.mode ?? 'fast',
      output_formats: params.outputFormats ?? ['markdown', 'pdf'],
      research_strategy: params.researchStrategy,
      report_format: params.reportFormat,
      search,
      urls: params.urls?.length ? params.urls : undefined,
      files: params.files?.length ? params.files : undefined,
      metadata: params.metadata && Object.keys(params.metadata).length ? params.metadata : undefined,
      tools: params.tools,
      mcp_servers: params.mcpServers?.length ? params.mcpServers : undefined,
      previous_reports: params.previousReports?.length ? params.previousReports : undefined,
      webhook_url: params.webhookUrl,
      alert_email: params.alertEmail,
      deliverables: params.deliverables?.length ? params.deliverables : undefined,
      hitl: params.hitl,
    };
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
    name?: string;
    mode?: string;
    outputFormats?: Array<string | Record<string, unknown>>;
    search?: {
      searchType?: string;
      includedSources?: string[];
      excludedSources?: string[];
      sourceBiases?: Record<string, number>;
      countryCode?: string;
      startDate?: string;
      endDate?: string;
    };
    webhookUrl?: string;
    alertEmail?: string | { email: string; custom_url?: string };
    mcpServers?: Array<Record<string, unknown>>;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>('/deepresearch/batches', {
      name: params.name,
      mode: params.mode ?? 'standard',
      output_formats: params.outputFormats ?? ['markdown'],
      search: params.search && buildSearchConfig(params.search),
      webhook_url: params.webhookUrl,
      alert_email: params.alertEmail,
      mcp_servers: params.mcpServers?.length ? params.mcpServers : undefined,
      metadata:
        params.metadata && Object.keys(params.metadata).length ? params.metadata : undefined,
    });
  }

  async listBatches(
    limit?: number,
  ): Promise<{ data: Record<string, unknown>[] | null; error: ValyuApiError | null }> {
    return this.get<Record<string, unknown>[]>(
      '/deepresearch/batches',
      limit ? { limit: String(limit) } : undefined,
    );
  }

  async getBatchStatus(
    id: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.get<Record<string, unknown>>(`/deepresearch/batches/${id}`);
  }

  // Batch tasks endpoint accepts rich per-task config. Minimal form: [{query: "..."}].
  async addBatchTasks(
    id: string,
    tasks: Array<Record<string, unknown>>,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.request<Record<string, unknown>>(`/deepresearch/batches/${id}/tasks`, { tasks });
  }

  async listBatchTasks(
    id: string,
    params?: {
      status?: string;
      limit?: number;
      lastKey?: string;
      includeOutput?: boolean;
    },
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    const qs: Record<string, string> = {};
    if (params?.status) qs.status = params.status;
    if (params?.limit) qs.limit = String(params.limit);
    if (params?.lastKey) qs.last_key = params.lastKey;
    if (params?.includeOutput) qs.include_output = 'true';
    return this.get<Record<string, unknown>>(
      `/deepresearch/batches/${id}/tasks`,
      Object.keys(qs).length ? qs : undefined,
    );
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
  structured_output?: Record<string, unknown>;
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
