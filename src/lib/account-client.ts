import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import { VERSION } from './version.js';

// Control-plane base. Overridable for staging via VALYU_ACCOUNT_API_BASE.
export const ACCOUNT_API_BASE = (
  process.env.VALYU_ACCOUNT_API_BASE ?? 'https://api.valyu.ai/v1/account'
).replace(/\/+$/, '');

// Fixed public CLI client_id for the RFC 8628 device flow (see ACCOUNT_API_PLAN §0.2).
export const CLI_CLIENT_ID = process.env.VALYU_CLI_CLIENT_ID ?? 'val_cli_public';

// Default requested scopes for device login: everything a self-provisioning
// agent needs EXCEPT billing:write (money movement is opt-in on the consent page).
export const DEFAULT_DEVICE_SCOPE = 'account:read keys:read keys:write billing:read inference';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// ─── Error shape (RFC 9457 + recovery envelope) ──────────────────────────────

export interface AccountApiError {
  message: string;
  code?: string;
  hint?: string;
  status?: number;
  retryable?: boolean;
  recovery?: Record<string, unknown>;
  fieldErrors?: Array<Record<string, unknown>>;
}

type RawEnvelope = {
  code?: string;
  title?: string;
  detail?: string;
  hint?: string;
  retryable?: boolean;
  recovery?: Record<string, unknown>;
  field_errors?: Array<Record<string, unknown>>;
  error?: string;
  message?: string;
};

function parseAccountError(status: number, body: RawEnvelope | null): AccountApiError {
  if (body && typeof body === 'object') {
    // RFC 9457 account envelope (has a machine `code`).
    if (body.code) {
      return {
        message: body.detail ?? body.title ?? `HTTP ${status}`,
        code: body.code,
        hint: body.hint,
        status,
        retryable: body.retryable,
        recovery: body.recovery,
        fieldErrors: body.field_errors,
      };
    }
    // RFC 8628 device form, or a plain {error|message} body.
    if (body.error) return { message: body.error, code: body.error, status };
    if (body.message) return { message: body.message, status, code: `http_${status}` };
  }
  return { message: `HTTP ${status}`, status, code: `http_${status}` };
}

// ─── Response types for the api.valyu.ai/v1/account/* endpoints ─

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  valyu_key_id: string | null;
  key_prefix: string;
}

// Single-poll result for the device token endpoint. The CLI loop branches on
// `status` to honour RFC 8628 polling discipline.
export type DeviceTokenPoll =
  | { status: 'success'; token: DeviceTokenResponse }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'error'; error: AccountApiError };

export interface AccountKey {
  id: string;
  name: string;
  key_prefix: string;
  status: string;
  type: string;
  created_by?: { id: string | null; type: string };
  created_at?: string | null;
  last_used_at?: string | null;
  scopes: string[];
  scoped_datasets: string[] | null;
  tier_ceiling: string | null;
  credit_cap_usd: number | null;
  credit_spent_usd: number;
  cap_window: string | null;
  rate_limit_rpm: number | null;
  expires_at: string | null;
}

export interface CreatedKey extends Partial<AccountKey> {
  id: string;
  api_key: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  credit_cap_usd: number | null;
  cap_window: string | null;
  status: string;
}

export interface RotatedKey {
  id: string;
  api_key: string;
  key_prefix: string;
  status: string;
  rotated_from: string;
}

export interface RevokedKey {
  id: string;
  status: string;
}

export interface MeResponse {
  org_id: string;
  name: string | null;
  tier: string;
  allowed_datasets: string[];
  will_invoice: boolean;
  grace_period_ends: string | null;
  key: {
    id: string | null;
    name: string | null;
    scopes: string[];
    credit_cap_usd: number | null;
    credit_spent_usd: number | null;
  };
}

export interface BalanceResponse {
  credit_balance_usd: number;
  payg_usage_usd: number;
  signup_credits_remaining_usd: number;
  credit_limit_usd: number | null;
  credit_limit_enabled: boolean;
  will_invoice: boolean;
  tier: string;
}

export interface TopupResponse {
  checkout_url: string;
  amount_usd: number;
  expires_at: string | null;
}

export interface UsageResponse {
  start: string | null;
  end: string | null;
  bucket: string;
  group_by: string;
  total_spend_usd: number;
  series: Array<Record<string, unknown>>;
}

export interface DatasetsResponse {
  tier: string;
  available_datasets: string[];
  key_scoped_datasets: string[] | null;
  tiers: Array<{ tier: string; price: string; adds: string[] }>;
}

export interface CreateKeyOpts {
  name: string;
  type?: 'user' | 'service_account';
  scopes?: string[];
  scopedDatasets?: string[];
  tierCeiling?: string;
  creditCapUsd?: number;
  capWindow?: 'total' | 'monthly';
  rateLimitRpm?: number;
  expiresAt?: string;
}

export interface UsageQuery {
  start?: string;
  end?: string;
  bucket?: string;
  groupBy?: string;
}

type Result<T> = { data: T | null; error: AccountApiError | null };

// ─── Client ──────────────────────────────────────────────────────────────────

export class AccountClient {
  private apiKey?: string;

  // apiKey is optional: the device-flow endpoints are public.
  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      body?: Record<string, unknown>;
      query?: Record<string, string | undefined>;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ): Promise<Result<T>> {
    const headers: Record<string, string> = {
      'User-Agent': `valyu-cli/${VERSION}`,
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && this.apiKey) headers['x-api-key'] = this.apiKey;

    let url = `${ACCOUNT_API_BASE}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) qs.set(k, v);
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(stripUndefined(opts.body)) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { data: null, error: { message, code: 'network_error' } };
    }

    let parsed: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      return { data: null, error: parseAccountError(res.status, parsed as RawEnvelope) };
    }
    return { data: (parsed as T) ?? null, error: null };
  }

  // ── Device flow (public, no auth) ──

  async deviceCode(scope?: string): Promise<Result<DeviceCodeResponse>> {
    return this.request<DeviceCodeResponse>('POST', '/device/code', {
      auth: false,
      body: { client_id: CLI_CLIENT_ID, scope: scope ?? DEFAULT_DEVICE_SCOPE },
    });
  }

  // One poll of the token endpoint. The device endpoints return RFC 8628
  // `{"error":"..."}` with HTTP 400, so we translate those into poll states.
  async deviceToken(deviceCode: string): Promise<DeviceTokenPoll> {
    const { data, error } = await this.request<DeviceTokenResponse>('POST', '/device/token', {
      auth: false,
      body: { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: CLI_CLIENT_ID },
    });
    if (data && data.access_token) return { status: 'success', token: data };
    const code = error?.code;
    if (code === 'authorization_pending') return { status: 'pending' };
    if (code === 'slow_down') return { status: 'slow_down' };
    if (code === 'access_denied') return { status: 'denied' };
    if (code === 'expired_token') return { status: 'expired' };
    return { status: 'error', error: error ?? { message: 'Unknown device token error' } };
  }

  // ── Account (auth required) ──

  async me(): Promise<Result<MeResponse>> {
    return this.request<MeResponse>('GET', '/me');
  }

  async listKeys(): Promise<Result<{ keys: AccountKey[] }>> {
    return this.request<{ keys: AccountKey[] }>('GET', '/keys');
  }

  async createKey(opts: CreateKeyOpts): Promise<Result<CreatedKey>> {
    return this.request<CreatedKey>('POST', '/keys', {
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        name: opts.name,
        type: opts.type,
        scopes: opts.scopes,
        scoped_datasets: opts.scopedDatasets,
        tier_ceiling: opts.tierCeiling,
        credit_cap_usd: opts.creditCapUsd,
        cap_window: opts.capWindow,
        rate_limit_rpm: opts.rateLimitRpm,
        expires_at: opts.expiresAt,
      },
    });
  }

  async revokeKey(id: string): Promise<Result<RevokedKey>> {
    return this.request<RevokedKey>('DELETE', `/keys/${encodeURIComponent(id)}`);
  }

  async rotateKey(id: string): Promise<Result<RotatedKey>> {
    return this.request<RotatedKey>('POST', `/keys/${encodeURIComponent(id)}`, {
      body: { action: 'rotate' },
    });
  }

  async updateKey(
    id: string,
    patch: { name?: string; status?: 'active' | 'inactive' | 'archived' },
  ): Promise<Result<AccountKey>> {
    return this.request<AccountKey>('POST', `/keys/${encodeURIComponent(id)}`, { body: patch });
  }

  async balance(): Promise<Result<BalanceResponse>> {
    return this.request<BalanceResponse>('GET', '/balance');
  }

  async topup(amountUsd: number): Promise<Result<TopupResponse>> {
    return this.request<TopupResponse>('POST', '/balance/topup', {
      headers: { 'Idempotency-Key': randomUUID() },
      body: { amount_usd: amountUsd },
    });
  }

  async usage(params: UsageQuery = {}): Promise<Result<UsageResponse>> {
    return this.request<UsageResponse>('GET', '/usage', {
      query: {
        start: params.start,
        end: params.end,
        bucket: params.bucket,
        group_by: params.groupBy,
      },
    });
  }

  async datasets(): Promise<Result<DatasetsResponse>> {
    return this.request<DatasetsResponse>('GET', '/datasets');
  }
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Render an account error consistently. JSON mode preserves code/hint/recovery
// (which agents use to self-heal); human mode prints message + hint.
export function outputAccountError(err: AccountApiError, json?: boolean): never {
  const asJson = json || !process.stdout.isTTY;
  if (asJson) {
    console.error(
      JSON.stringify(
        {
          error: {
            message: err.message,
            code: err.code ?? 'unknown',
            hint: err.hint,
            retryable: err.retryable,
            recovery: err.recovery,
            field_errors: err.fieldErrors,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`${pc.red('Error:')} ${err.message}`);
    if (err.hint) console.error(`  ${pc.dim('Hint:')} ${err.hint}`);
  }
  process.exit(1);
}
