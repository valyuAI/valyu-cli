import { resolveApiKey, type ResolvedKey } from './config.js';
import { outputError } from './output.js';
import { VERSION } from './version.js';

export const VALYU_API_BASE = 'https://api.valyu.ai/v1';
export const PLATFORM_URL = 'https://platform.valyu.ai';
export const DOCS_URL = 'https://docs.valyu.ai';
export const PRICING_URL = 'https://www.valyu.ai/pricing';

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

export interface ValyuApiError {
  message: string;
  code?: string;
}

type ApiResult<T> = { data: T | null; error: ValyuApiError | null };

/**
 * Turn a failed response into a message that says what to do next. The status
 * alone is ambiguous - a 403 can be a rejected key, a dataset above the plan,
 * a source search cannot reach, or a limit the key has not been granted - and
 * each needs different advice. `code` stays `http_<status>` so scripts that
 * branch on it keep working.
 */
export function describeApiError(status: number, body: unknown, statusText = ''): ValyuApiError {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const said =
    (typeof b.error === 'string' && b.error) ||
    (typeof b.message === 'string' && b.message) ||
    `HTTP ${status}${statusText ? `: ${statusText}` : ''}`;
  const restricted = Array.isArray(b.restricted_sources)
    ? b.restricted_sources.filter((s): s is string => typeof s === 'string')
    : [];

  let hint: string | undefined;
  if (status === 402) {
    hint =
      'The account is out of credits, so retrying will fail the same way. ' +
      `Add credits at ${PLATFORM_URL} or with \`valyu account topup\`.`;
  } else if (status === 429) {
    hint = 'Rate limited. Wait a few seconds and retry.';
  } else if (status === 403 && restricted.length) {
    hint =
      `These sources cannot be searched directly: ${restricted.join(', ')}. ` +
      'Remove them from --include-source; `valyu sources` lists what you can search.';
  } else if (status === 403 && b.code === 'tier_insufficient') {
    hint =
      'Retry without --include-source: an unscoped search covers every dataset your plan includes. ' +
      `\`valyu sources\` shows which datasets are locked; plans are described at ${PRICING_URL}.`;
  } else if (status === 401 || (status === 403 && /credential|api[_ -]?key|unauthori[sz]ed|invalid token/i.test(said))) {
    hint = `The API key was rejected. Run \`valyu login\`, or check the key at ${PLATFORM_URL}.`;
  } else if (status === 422) {
    hint = 'Nothing usable matched in the requested scope. Drop --include-source or the date filters, or broaden the query.';
  } else if (status >= 500) {
    hint = 'This is usually transient - retry once.';
  }
  return { message: hint ? `${said}\n\n${hint}` : said, code: `http_${status}` };
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

  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { body?: Record<string, unknown>; query?: Record<string, string | undefined> } = {},
  ): Promise<ApiResult<T>> {
    const url = new URL(`${VALYU_API_BASE}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'User-Agent': `valyu-cli/${VERSION}`,
    };
    let body: string | undefined;
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      // Undefined keys are dropped so optional flags never reach the API.
      body = JSON.stringify(
        Object.fromEntries(Object.entries(opts.body).filter(([, v]) => v !== undefined)),
      );
    }

    try {
      const res = await fetch(url.toString(), { method, headers, body });
      if (!res.ok) {
        let parsed: unknown = null;
        try {
          parsed = await res.json();
        } catch {
          // non-JSON error body: fall back to the status line
        }
        return { data: null, error: describeApiError(res.status, parsed, res.statusText) };
      }
      return { data: (await res.json()) as T, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { data: null, error: { message, code: 'network_error' } };
    }
  }

  private get<T>(path: string, query?: Record<string, string | undefined>): Promise<ApiResult<T>> {
    return this.send<T>('GET', path, { query });
  }

  private del<T>(path: string): Promise<ApiResult<T>> {
    return this.send<T>('DELETE', path);
  }

  private request<T>(
    path: string,
    payload: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<ApiResult<T>> {
    return this.send<T>(method, path, { body: payload });
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

  /**
   * POST /search. No `search_type` is sent: unscoped, the API routes across the
   * live web and every dataset the plan covers; scoped, it infers the mode from
   * `included_sources`.
   */
  async search(params: {
    query: string;
    maxNumResults?: number;
    responseLength?: number;
    includedSources?: string[];
    excludedSources?: string[];
    sourceBiases?: Record<string, number>;
    startDate?: string;
    endDate?: string;
    countryCode?: string;
  }): Promise<ApiResult<SearchResult>> {
    return this.request<SearchResult>('/search', {
      query: params.query,
      max_num_results: params.maxNumResults ?? 10,
      response_length: params.responseLength,
      included_sources: params.includedSources?.length ? params.includedSources : undefined,
      excluded_sources: params.excludedSources?.length ? params.excludedSources : undefined,
      source_biases:
        params.sourceBiases && Object.keys(params.sourceBiases).length ? params.sourceBiases : undefined,
      start_date: params.startDate,
      end_date: params.endDate,
      country_code: params.countryCode,
    });
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
    /** true for a general summary, or a string instruction for what to extract. */
    summary?: boolean | string;
    responseLength?: number;
    extractEffort?: 'auto' | 'normal' | 'high';
    screenshot?: boolean;
  }): Promise<ApiResult<ContentsResult>> {
    return this.request<ContentsResult>('/contents', {
      urls: params.urls,
      summary: params.summary || undefined,
      response_length: params.responseLength,
      extract_effort: params.extractEffort ?? 'auto',
      screenshot: params.screenshot || undefined,
    });
  }

  async createResearch(params: {
    query?: string;
    workflowId?: string;
    workflowParams?: Record<string, unknown>;
    workflowVersion?: number;
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
    tools?: { code_execution?: boolean; screenshots?: boolean; browser_use?: boolean; charts?: boolean };
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
      workflow_id: params.workflowId,
      workflow_params:
        params.workflowParams && Object.keys(params.workflowParams).length ? params.workflowParams : undefined,
      workflow_version: params.workflowVersion,
      mode: params.mode,
      output_formats: params.outputFormats,
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

  // ─── DeepResearch Workflows ───────────────────────────────────────────────
  // Workflows are templated, versioned deep-research starting points. List and
  // inspect curated (Valyu) or org-owned templates, preview the resolved task,
  // then run one via POST /deepresearch/tasks with workflow_id + workflow_params.

  async listWorkflows(params?: {
    vertical?: string;
    scope?: string;
    query?: string;
    tags?: string[];
    limit?: number;
    expand?: boolean;
  }): Promise<{ data: WorkflowListResult | null; error: ValyuApiError | null }> {
    const qs: Record<string, string> = {};
    if (params?.vertical) qs.vertical = params.vertical;
    if (params?.scope) qs.scope = params.scope;
    if (params?.query) qs.q = params.query;
    if (params?.tags?.length) qs.tags = params.tags.join(',');
    if (params?.limit) qs.limit = String(params.limit);
    if (params?.expand) qs.expand = 'true';
    return this.get<WorkflowListResult>('/workflows', Object.keys(qs).length ? qs : undefined);
  }

  async getWorkflow(
    slug: string,
    version?: number,
  ): Promise<{ data: WorkflowDetail | null; error: ValyuApiError | null }> {
    return this.get<WorkflowDetail>(
      `/workflows/${encodeURIComponent(slug)}`,
      version != null ? { version: String(version) } : undefined,
    );
  }

  async listWorkflowVersions(
    slug: string,
  ): Promise<{ data: WorkflowVersionsResult | null; error: ValyuApiError | null }> {
    return this.get<WorkflowVersionsResult>(`/workflows/${encodeURIComponent(slug)}/versions`);
  }

  async getWorkflowVersion(
    slug: string,
    version: number,
  ): Promise<{ data: WorkflowDetail | null; error: ValyuApiError | null }> {
    return this.get<WorkflowDetail>(`/workflows/${encodeURIComponent(slug)}/versions/${version}`);
  }

  async previewWorkflow(
    slug: string,
    workflowParams?: Record<string, unknown>,
    version?: number,
  ): Promise<{ data: WorkflowPreviewResult | null; error: ValyuApiError | null }> {
    return this.request<WorkflowPreviewResult>(`/workflows/${encodeURIComponent(slug)}/preview`, {
      workflow_params: workflowParams ?? {},
      workflow_version: version,
    });
  }

  async createWorkflow(
    body: Record<string, unknown>,
  ): Promise<{ data: WorkflowDetail | null; error: ValyuApiError | null }> {
    return this.request<WorkflowDetail>('/workflows', body);
  }

  async updateWorkflow(
    slug: string,
    body: Record<string, unknown>,
  ): Promise<{ data: WorkflowDetail | null; error: ValyuApiError | null }> {
    return this.request<WorkflowDetail>(`/workflows/${encodeURIComponent(slug)}`, body, 'PATCH');
  }

  async deleteWorkflow(
    slug: string,
  ): Promise<{ data: Record<string, unknown> | null; error: ValyuApiError | null }> {
    return this.del<Record<string, unknown>>(`/workflows/${encodeURIComponent(slug)}`);
  }

  // Run a workflow: creates a normal deep-research task from the template. Only
  // sends optional overrides when provided so the template's own recommended
  // mode / output formats apply by default.
  async runWorkflow(params: {
    slug: string;
    workflowParams?: Record<string, unknown>;
    version?: number;
    mode?: string;
    webhookUrl?: string;
    alertEmail?: string | { email: string; custom_url?: string };
  }): Promise<{ data: ResearchTask | null; error: ValyuApiError | null }> {
    return this.request<ResearchTask>('/deepresearch/tasks', {
      workflow_id: params.slug,
      workflow_params:
        params.workflowParams && Object.keys(params.workflowParams).length
          ? params.workflowParams
          : undefined,
      workflow_version: params.version,
      mode: params.mode,
      webhook_url: params.webhookUrl,
      alert_email: params.alertEmail,
    });
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

  /** Rank the dataset catalog against a plain-language description of the data needed. */
  async searchDatasources(
    query: string,
    limit = 8,
  ): Promise<ApiResult<{ results?: Array<{ id: string; relevance_score?: number }> }>> {
    return this.get('/datasources/search', { q: query, limit: String(limit) });
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
  description?: string;
  publication_date?: string;
  authors?: string[];
  doi?: string;
  citation?: string;
  citation_count?: number;
  pmid?: string;
  pmcid?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  success?: boolean;
  /** Set on a 200 when a backend failed; "No results found" is benign. */
  error?: string;
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
  content?: unknown;
  summary?: unknown;
  length?: number;
  data_type?: string;
  screenshot_url?: string;
  error?: string;
}

export interface ContentsResult {
  success?: boolean;
  error?: string;
  results: ContentsItem[];
  urls_requested: number;
  urls_processed: number;
  urls_failed: number;
  total_cost_dollars?: number;
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
  title?: string;
  input?: string;
  mode?: string;
  output?: unknown;
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
  cost_breakdown?: Record<string, number>;
  usage?: { search_cost: number; ai_cost: number; total_cost: number };
  created_at?: string | number;
  completed_at?: string | number;
  error?: string;
  public?: boolean;
  /** The agent's full transcript - tens of KB, never shown. */
  messages?: unknown;
}

export interface ResearchListItem {
  deepresearch_id: string;
  query: string;
  title?: string;
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
  name?: string;
  description?: string;
  count?: number;
}

export interface DatasourcesResult {
  datasources: Datasource[];
  categories?: Record<string, DatasourceCategory>;
}

// ─── DeepResearch Workflows ───────────────────────────────────────────────────

export interface WorkflowVariable {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'enum';
  required?: boolean;
  placeholder?: string;
  help?: string;
  examples?: string[];
  validation?: {
    min_length?: number;
    max_length?: number;
    pattern?: string;
    enum?: string[];
  };
}

export interface WorkflowDeliverable {
  type: string;
  description: string;
}

export interface WorkflowTools {
  code_execution?: boolean;
  screenshots?: boolean;
  browser_use?: boolean;
  charts?: boolean;
}

// List item; template fields (prompt/strategy/...) present only with ?expand=true.
export interface Workflow {
  slug: string;
  version: number;
  vertical: string | null;
  tags: string[];
  title: string;
  subtitle: string | null;
  description: string | null;
  popular: boolean;
  recommended_mode: 'fast' | 'standard' | 'heavy' | 'max';
  estimated_time: string | null;
  is_valyu: boolean;
  owner_org_id: string | null;
  variables: WorkflowVariable[];
  deliverables: WorkflowDeliverable[];
  created_at: string;
  updated_at: string;
  prompt?: string;
  strategy?: string;
  report_format?: string;
  tools?: WorkflowTools;
}

// Detail / create / update response: template fields always present.
export interface WorkflowDetail extends Workflow {
  prompt: string;
  strategy: string;
  report_format: string;
  tools: WorkflowTools;
  changelog: string | null;
}

export interface WorkflowListResult {
  workflows: Workflow[];
  total: number;
  next_cursor: string | null;
  verticals: string[];
}

export interface WorkflowVersionSummary {
  version: number;
  recommended_mode: 'fast' | 'standard' | 'heavy' | 'max';
  estimated_time: string | null;
  changelog: string | null;
  created_at: string;
  is_current: boolean;
}

export interface WorkflowVersionsResult {
  slug: string;
  versions: WorkflowVersionSummary[];
}

export interface WorkflowPreviewResult {
  workflow: { slug: string; version: number };
  resolved: {
    input: string;
    research_strategy: string;
    report_format: string;
    deliverables: WorkflowDeliverable[];
    mode: string;
    tools: WorkflowTools;
  };
  estimated_credits: number | null;
}
