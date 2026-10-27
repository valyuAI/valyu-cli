import pc from 'picocolors';

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface OutputOptions {
  json?: boolean;
  exitCode?: number;
}

function shouldOutputJson(json?: boolean): boolean {
  if (json) return true;
  if (!process.stdout.isTTY) return true;
  return false;
}

export function outputResult(data: unknown, opts: OutputOptions = {}): void {
  if (shouldOutputJson(opts.json)) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (typeof data === 'string') {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }
  if (opts.exitCode !== undefined) {
    process.exit(opts.exitCode);
  }
}

/**
 * The messages in a response's `warnings` list. Items are `{type, message, detail?}`
 * objects; older responses send plain strings. Anything else is skipped.
 */
export function warningMessages(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((w) => (typeof w === 'string' ? w : (w as { message?: unknown } | null)?.message))
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '');
}

/** Print each warning on stderr, keeping stdout clean. */
export function printWarnings(warnings: unknown): void {
  for (const message of warningMessages(warnings)) {
    console.error(`${pc.yellow('Warning:')} ${message}`);
  }
}

export interface ErrorDetail {
  message: string;
  code?: string;
  /** Seconds to wait before retrying. Present only on a 429. */
  retryAfter?: number;
  /** The caller's current plan name. Present only on a 429. */
  plan?: string;
  /** Which bucket was limited and its sustained rate. Present only on a 429. */
  limit?: { endpoint?: string; requests_per_second?: number };
  /** Self-serve upgrade link. Present on a 429 for payg/tier_1/tier_2. */
  upgradeUrl?: string;
  /** Sales contact link. Present on a 429 for tier_3/enterprise/custom plans. */
  contactUrl?: string;
}

export function outputError(error: ErrorDetail, opts: OutputOptions = {}): never {
  const exitCode = opts.exitCode ?? 1;
  if (shouldOutputJson(opts.json)) {
    console.error(
      JSON.stringify(
        {
          error: {
            message: error.message,
            code: error.code ?? 'unknown',
            ...(error.retryAfter !== undefined ? { retry_after: error.retryAfter } : {}),
            ...(error.plan !== undefined ? { plan: error.plan } : {}),
            ...(error.limit !== undefined ? { limit: error.limit } : {}),
            ...(error.upgradeUrl !== undefined ? { upgrade_url: error.upgradeUrl } : {}),
            ...(error.contactUrl !== undefined ? { contact_url: error.contactUrl } : {}),
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`${pc.red('Error:')} ${error.message}`);
    if (error.upgradeUrl) {
      console.error(`  ${pc.dim('Upgrade:')} ${error.upgradeUrl}`);
    } else if (error.contactUrl) {
      console.error(`  ${pc.dim('Contact:')} ${error.contactUrl}`);
    }
  }
  process.exit(exitCode);
}
