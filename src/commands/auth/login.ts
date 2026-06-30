import * as p from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, PLATFORM_URL } from '../../lib/client.js';
import {
  AccountClient,
  DEFAULT_DEVICE_SCOPE,
  type AccountApiError,
  type DeviceCodeResponse,
} from '../../lib/account-client.js';
import { storeApiKey } from '../../lib/config.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';
import { openInBrowser } from '../../lib/browser.js';
import { isInteractive } from '../../lib/tty.js';

const API_KEYS_URL = `${PLATFORM_URL}/user/account/apikeys`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const loginCommand = new Command('login')
  .description('Authenticate the CLI (device flow by default; mints a scoped Valyu key)')
  .option('--key <key>', 'Authenticate with an existing API key (manual / CI mode)')
  .option('--device', 'Force the browser device flow (default when --key is omitted)')
  .option('--no-browser', 'Do not auto-open the browser; print the URL to visit instead')
  .option('--scope <scope>', 'Space-separated scopes to request for the minted key')
  .option('--profile <name>', 'Profile name to save the key under (default: "default")')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('# Browser device flow - mints a scoped val_ key, nothing to paste')}
  ${pc.cyan('$ valyu login')}

  ${pc.dim('# Headless device flow (prints the URL + code, no browser)')}
  ${pc.cyan('$ valyu login --no-browser')}

  ${pc.dim('# Agent / CI: parse line-delimited JSON events')}
  ${pc.cyan('$ valyu login --json')}

  ${pc.dim('# Manual / CI with an existing key')}
  ${pc.cyan('$ valyu login --key val_xxx')}
`,
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts & {
      key?: string;
      device?: boolean;
      browser?: boolean;
      scope?: string;
      profile?: string;
    };
    const profileName = opts.profile ?? globalOpts.profile ?? 'default';
    const manualKey = opts.key?.trim();

    // A supplied --key uses the manual path; otherwise (and with explicit
    // --device) we run the RFC 8628 browser device flow, the default.
    if (manualKey) {
      await manualLogin(manualKey, profileName, globalOpts);
      return;
    }

    await deviceLogin(profileName, globalOpts, {
      scope: opts.scope,
      openBrowser: opts.browser !== false,
    });
  });

// ─── Device flow (default) ────────────────────────────────────────────────────

function isJsonMode(globalOpts: GlobalOpts): boolean {
  return Boolean(globalOpts.json || globalOpts.quiet || !isInteractive());
}

function emitEvent(obj: Record<string, unknown>): void {
  // Single line per event so agents can parse the stream incrementally.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function deviceLogin(
  profile: string,
  globalOpts: GlobalOpts,
  flow: { scope?: string; openBrowser: boolean },
): Promise<void> {
  const json = isJsonMode(globalOpts);
  const client = new AccountClient();

  const failDevice = (err: AccountApiError): never => {
    if (json) {
      emitEvent({ event: 'auth_error', error: { message: err.message, code: err.code, hint: err.hint } });
      process.exit(1);
    }
    outputError({ message: err.message, code: err.code }, { json: false });
  };

  // 1. Request a device + user code.
  const { data: dc, error: codeErr } = await client.deviceCode(flow.scope ?? DEFAULT_DEVICE_SCOPE);
  if (codeErr || !dc) {
    failDevice(codeErr ?? { message: 'Failed to start device authorization' });
    return;
  }

  // 2. Surface the user code + verification URL, then open the browser.
  if (json) {
    emitEvent({
      event: 'device_code',
      user_code: dc.user_code,
      verification_uri: dc.verification_uri,
      verification_uri_complete: dc.verification_uri_complete,
      expires_in: dc.expires_in,
      interval: dc.interval,
    });
  } else {
    printDevicePrompt(dc);
  }

  if (flow.openBrowser && !json) {
    await openInBrowser(dc.verification_uri_complete);
  }

  // 3. Poll the token endpoint honouring interval / slow_down / expires_in.
  const spinner = json ? null : createSpinner('Waiting for you to approve in the browser...', globalOpts.quiet);
  const deadline = Date.now() + dc.expires_in * 1000;
  let interval = dc.interval;
  let attempt = 0;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    attempt += 1;
    const poll = await client.deviceToken(dc.device_code);

    if (poll.status === 'success') {
      const token = poll.token;
      const configPath = storeApiKey(token.access_token, profile, token.valyu_key_id ?? undefined);
      if (json) {
        emitEvent({
          event: 'auth_success',
          profile,
          valyu_key_id: token.valyu_key_id,
          key_prefix: token.key_prefix,
          scope: token.scope,
          config_path: configPath,
        });
        return;
      }
      spinner?.stop('Authorized');
      p.outro(
        `Logged in as ${pc.cyan(token.key_prefix)} - key stored for profile ${pc.cyan(`'${profile}'`)}`,
      );
      return;
    }

    if (poll.status === 'slow_down') {
      interval += 5; // RFC 8628: back off by 5s cumulatively.
      if (json) emitEvent({ event: 'auth_waiting', status: 'slow_down', attempt, interval });
      continue;
    }
    if (poll.status === 'pending') {
      if (json) emitEvent({ event: 'auth_waiting', status: 'authorization_pending', attempt });
      continue;
    }
    if (poll.status === 'denied') {
      spinner?.fail('Authorization denied');
      failDevice({ message: 'Authorization was denied in the browser.', code: 'access_denied' });
      return;
    }
    if (poll.status === 'expired') {
      spinner?.fail('Device code expired');
      failDevice({ message: 'The device code expired. Run `valyu login` again.', code: 'expired_token' });
      return;
    }
    // status === 'error'
    spinner?.fail('Login failed');
    failDevice(poll.error);
    return;
  }

  spinner?.fail('Device code expired');
  failDevice({ message: 'Timed out waiting for approval. Run `valyu login` again.', code: 'expired_token' });
}

function printDevicePrompt(dc: DeviceCodeResponse): void {
  p.intro(`${pc.cyan('Valyu')} Authentication`);
  p.note(
    `${pc.dim('1.')} Open ${pc.cyan(dc.verification_uri)}\n` +
      `${pc.dim('2.')} Enter the code below and approve\n\n` +
      `   ${pc.bold(pc.cyan(dc.user_code))}\n\n` +
      `${pc.dim('Or open directly:')} ${pc.dim(dc.verification_uri_complete)}`,
    'Confirm this code matches your screen, then approve',
  );
}

// ─── Manual key flow (--key / CI) ─────────────────────────────────────────────

async function manualLogin(
  providedKey: string | undefined,
  profileName: string,
  globalOpts: GlobalOpts,
): Promise<void> {
  let apiKey = providedKey;

  if (!apiKey) {
    if (!isInteractive() || globalOpts.json) {
      outputError(
        {
          message: 'Missing --key flag. Provide your Valyu API key in non-interactive mode.',
          code: 'missing_key',
        },
        { json: globalOpts.json },
      );
    }

    p.intro(`${pc.cyan('Valyu')} Authentication`);
    p.note(`Get your free API key at ${pc.cyan(API_KEYS_URL)}`, 'Where to get your key');

    const result = await p.password({
      message: 'Enter your Valyu API key:',
      validate: (value) => {
        if (!value) return 'API key is required';
        if (value.length < 16) return 'API key appears too short';
        return undefined;
      },
    });

    if (p.isCancel(result)) {
      p.cancel('Login cancelled.');
      process.exit(0);
    }

    apiKey = result.trim();
  }

  if (!apiKey || apiKey.length < 16) {
    outputError({ message: 'Invalid API key format.', code: 'invalid_key_format' }, { json: globalOpts.json });
  }

  const spinner = createSpinner('Validating API key...', globalOpts.quiet);
  const client = new ValyuClient(apiKey);
  const { valid, error } = await client.validateKey();

  if (!valid) {
    spinner.fail('API key validation failed');
    outputError({ message: error ?? 'Invalid API key', code: 'validation_failed' }, { json: globalOpts.json });
  }

  spinner.stop('API key is valid');

  // Manual keys: we don't know the server-side key id, so no valyu_key_id.
  const configPath = storeApiKey(apiKey, profileName);

  if (globalOpts.json || !isInteractive()) {
    outputResult({ success: true, config_path: configPath, profile: profileName }, { json: true });
  } else {
    p.outro(`Logged in. API key stored for profile ${pc.cyan(`'${profileName}'`)}`);
  }
}
