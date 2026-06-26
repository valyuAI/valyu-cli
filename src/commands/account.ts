import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../lib/client.js';
import { requireApiKey } from '../lib/client.js';
import {
  AccountClient,
  outputAccountError,
  type CreatedKey,
  type MeResponse,
  type BalanceResponse,
  type DatasetsResponse,
} from '../lib/account-client.js';
import { outputResult } from '../lib/output.js';
import { createSpinner } from '../lib/spinner.js';
import { openInBrowser } from '../lib/browser.js';
import { relTime } from '../lib/format.js';

function client(globalOpts: GlobalOpts): AccountClient {
  return new AccountClient(requireApiKey(globalOpts).key);
}

function isJson(globalOpts: GlobalOpts): boolean {
  return Boolean(globalOpts.json || globalOpts.quiet || !process.stdout.isTTY);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return `$${n.toFixed(2)}`;
}

function fmtCap(key: { credit_cap_usd: number | null; credit_spent_usd: number; cap_window: string | null }): string {
  if (key.credit_cap_usd === null || key.credit_cap_usd === undefined) return pc.dim('uncapped');
  const remaining = Math.max(0, key.credit_cap_usd - (key.credit_spent_usd ?? 0));
  const window = key.cap_window ? ` ${key.cap_window}` : '';
  return `${fmtUsd(key.credit_spent_usd)} / ${fmtUsd(key.credit_cap_usd)}${window} ${pc.dim(`(${fmtUsd(remaining)} left)`)}`;
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  active: pc.green,
  inactive: pc.yellow,
  archived: pc.dim,
  revoked: pc.red,
};

function colorStatus(s: string): string {
  return (STATUS_COLOR[s] ?? pc.white)(s);
}

// ─── whoami ───────────────────────────────────────────────────────────────────

const whoamiCmd = new Command('whoami')
  .description('Show the org, tier, and calling key for the current credentials')
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const c = client(globalOpts);
    const spinner = createSpinner('Loading account...', globalOpts.quiet);
    const { data, error } = await c.me();
    if (error) {
      spinner.fail('Failed to load account');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Account loaded');
    const me = data as MeResponse;

    if (isJson(globalOpts)) {
      outputResult(me, { json: true });
      return;
    }
    console.log('');
    console.log(`  ${pc.bold('Organisation:')} ${me.name ?? pc.dim('(unnamed)')} ${pc.dim(me.org_id)}`);
    console.log(`  ${pc.bold('Tier:')}         ${pc.cyan(me.tier)}`);
    console.log(`  ${pc.bold('Billing:')}      ${me.will_invoice ? 'invoiced' : 'pay-as-you-go'}`);
    console.log(`  ${pc.bold('Key:')}          ${me.key.name ?? pc.dim('(unnamed)')} ${pc.dim(me.key.id ?? '')}`);
    console.log(`  ${pc.bold('Scopes:')}       ${(me.key.scopes ?? []).join(', ') || pc.dim('none')}`);
    if (me.key.credit_cap_usd !== null && me.key.credit_cap_usd !== undefined) {
      console.log(
        `  ${pc.bold('Budget:')}       ${fmtUsd(me.key.credit_spent_usd)} / ${fmtUsd(me.key.credit_cap_usd)}`,
      );
    }
    console.log(`  ${pc.bold('Datasets:')}     ${pc.dim(`${me.allowed_datasets.length} available`)}`);
    console.log('');
  });

// ─── keys list ────────────────────────────────────────────────────────────────

const keysListCmd = new Command('list')
  .description('List API keys for the organisation')
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const c = client(globalOpts);
    const spinner = createSpinner('Loading keys...', globalOpts.quiet);
    const { data, error } = await c.listKeys();
    if (error) {
      spinner.fail('Failed to load keys');
      outputAccountError(error, globalOpts.json);
    }
    const keys = data!.keys ?? [];
    spinner.stop(`${keys.length} key${keys.length === 1 ? '' : 's'}`);

    if (isJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    if (keys.length === 0) {
      console.log(`\n  ${pc.dim('No keys yet. Create one:')} ${pc.cyan('valyu account keys create --name my-agent --cap 5')}\n`);
      return;
    }
    console.log('');
    for (const k of keys) {
      console.log(`  ${pc.bold(k.name)}  ${pc.dim(k.key_prefix)}  ${colorStatus(k.status)}`);
      console.log(`    ${pc.dim('id')}       ${k.id}`);
      console.log(`    ${pc.dim('scopes')}   ${(k.scopes ?? []).join(', ') || pc.dim('none')}`);
      console.log(`    ${pc.dim('budget')}   ${fmtCap(k)}`);
      if (k.expires_at) console.log(`    ${pc.dim('expires')}  ${k.expires_at}`);
      if (k.last_used_at) console.log(`    ${pc.dim('used')}     ${relTime(k.last_used_at)}`);
      console.log('');
    }
  });

// ─── keys create ──────────────────────────────────────────────────────────────

const keysCreateCmd = new Command('create')
  .description('Create a new API key (optionally budget-capped)')
  .requiredOption('--name <name>', 'Human-readable key name')
  .option('--cap <usd>', 'Spend cap in USD (omit for uncapped)')
  .option('--window <window>', 'Cap window: total | monthly', 'total')
  .option('--scopes <list>', 'Comma-separated MANAGEMENT scopes: account:read, keys:read, keys:write, billing:read, billing:write (default: none - search/data access is automatic)')
  .option('--type <type>', 'Key type: user | service_account', 'user')
  .option('--rate-limit <rpm>', 'Rate limit in requests per minute')
  .option('--expires <iso>', 'Expiry as an ISO 8601 timestamp')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('# Budget-capped agent key - the headline pattern')}
  ${pc.cyan('$ valyu account keys create --name agent --cap 5')}

  ${pc.dim('# Monthly cap, search-only (no management scopes - the agent default)')}
  ${pc.cyan('$ valyu account keys create --name research-bot --cap 50 --window monthly')}

  ${pc.dim('# Grant management scopes so the key can read the account + rotate keys')}
  ${pc.cyan('$ valyu account keys create --name ops --scopes account:read,keys:read,keys:write')}
`,
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    const cap = opts.cap !== undefined ? Number(opts.cap) : undefined;
    if (cap !== undefined && (Number.isNaN(cap) || cap <= 0)) {
      outputAccountError({ message: '--cap must be a positive number.', code: 'invalid_cap' }, globalOpts.json);
    }
    const window = opts.window === 'monthly' ? 'monthly' : 'total';
    const type = opts.type === 'service_account' ? 'service_account' : 'user';
    const rateLimit = opts.rateLimit !== undefined ? Number(opts.rateLimit) : undefined;
    if (rateLimit !== undefined && Number.isNaN(rateLimit)) {
      outputAccountError({ message: '--rate-limit must be a number.', code: 'invalid_rate_limit' }, globalOpts.json);
    }

    const c = client(globalOpts);
    const spinner = createSpinner('Creating key...', globalOpts.quiet);
    const { data, error } = await c.createKey({
      name: opts.name,
      type,
      scopes: opts.scopes ? splitList(opts.scopes) : undefined,
      creditCapUsd: cap,
      capWindow: cap !== undefined ? window : undefined,
      rateLimitRpm: rateLimit,
      expiresAt: opts.expires,
    });
    if (error) {
      spinner.fail('Key creation failed');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Key created');
    const key = data as CreatedKey;

    if (isJson(globalOpts)) {
      outputResult(key, { json: true });
      return;
    }
    console.log('');
    console.log(`  ${pc.green('Created key')} ${pc.bold(key.name)}  ${pc.dim(key.key_prefix)}`);
    console.log(`    ${pc.dim('id')}      ${key.id}`);
    console.log(`    ${pc.dim('scopes')}  ${(key.scopes ?? []).join(', ') || pc.dim('none')}`);
    if (key.credit_cap_usd !== null && key.credit_cap_usd !== undefined) {
      console.log(
        `    ${pc.dim('budget')}  ${pc.bold(fmtUsd(key.credit_cap_usd))}${key.cap_window ? ` ${key.cap_window}` : ''} ${pc.dim('spend cap')}`,
      );
    } else {
      console.log(`    ${pc.dim('budget')}  ${pc.yellow('uncapped')}`);
    }
    console.log('');
    console.log(`  ${pc.yellow('Save this secret now - it is shown only once:')}`);
    console.log('');
    console.log(`    ${pc.bold(key.api_key)}`);
    console.log('');
    console.log(`  ${pc.dim('Use it with:')} ${pc.dim(`VALYU_API_KEY=${key.key_prefix}... valyu search "..."`)}`);
    console.log('');
  });

// ─── keys revoke ──────────────────────────────────────────────────────────────

const keysRevokeCmd = new Command('revoke')
  .description('Revoke an API key by id (immediate, irreversible)')
  .argument('<id>', 'Key id to revoke')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const c = client(globalOpts);
    const spinner = createSpinner('Revoking key...', globalOpts.quiet);
    const { data, error } = await c.revokeKey(id);
    if (error) {
      spinner.fail('Revoke failed');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Key revoked');
    if (isJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    console.log(`\n  ${pc.red('Revoked')} ${pc.dim(id)}\n`);
  });

// ─── keys rotate ──────────────────────────────────────────────────────────────

const keysRotateCmd = new Command('rotate')
  .description('Rotate an API key: revoke the old secret, mint a new one with the same settings')
  .argument('<id>', 'Key id to rotate')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const c = client(globalOpts);
    const spinner = createSpinner('Rotating key...', globalOpts.quiet);
    const { data, error } = await c.rotateKey(id);
    if (error) {
      spinner.fail('Rotate failed');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Key rotated');
    if (isJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    console.log('');
    console.log(`  ${pc.green('Rotated')} ${pc.dim(data!.rotated_from)} ${pc.dim('->')} ${pc.bold(data!.key_prefix)}`);
    console.log('');
    console.log(`  ${pc.yellow('New secret - shown only once:')}`);
    console.log('');
    console.log(`    ${pc.bold(data!.api_key)}`);
    console.log('');
  });

const keysCmd = new Command('keys')
  .description('Manage API keys')
  .addCommand(keysListCmd, { isDefault: true })
  .addCommand(keysCreateCmd)
  .addCommand(keysRevokeCmd)
  .addCommand(keysRotateCmd);

// ─── balance ──────────────────────────────────────────────────────────────────

const balanceCmd = new Command('balance')
  .description('Show the organisation credit balance and usage')
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const c = client(globalOpts);
    const spinner = createSpinner('Loading balance...', globalOpts.quiet);
    const { data, error } = await c.balance();
    if (error) {
      spinner.fail('Failed to load balance');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Balance loaded');
    const b = data as BalanceResponse;

    if (isJson(globalOpts)) {
      outputResult(b, { json: true });
      return;
    }
    console.log('');
    console.log(`  ${pc.bold('Balance:')}   ${pc.green(fmtUsd(b.credit_balance_usd))}`);
    console.log(`  ${pc.bold('PAYG used:')} ${fmtUsd(b.payg_usage_usd)}`);
    if (b.signup_credits_remaining_usd > 0) {
      console.log(`  ${pc.bold('Free:')}      ${fmtUsd(b.signup_credits_remaining_usd)} ${pc.dim('signup credits')}`);
    }
    if (b.credit_limit_enabled && b.credit_limit_usd !== null) {
      console.log(`  ${pc.bold('Limit:')}     ${fmtUsd(b.credit_limit_usd)}`);
    }
    console.log(`  ${pc.bold('Tier:')}      ${pc.cyan(b.tier)}`);
    if (b.credit_balance_usd <= 0) {
      console.log(`\n  ${pc.dim('Top up:')} ${pc.cyan('valyu account topup 25')}`);
    }
    console.log('');
  });

// ─── topup ────────────────────────────────────────────────────────────────────

const topupCmd = new Command('topup')
  .description('Add credits - charges your card on file, or returns a checkout link if none')
  .argument('<amount>', 'Amount in USD to add')
  .option('--open', 'Open the checkout URL in the browser (only when a checkout link is returned)')
  .action(async (amount, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const amt = Number(amount);
    if (Number.isNaN(amt) || amt <= 0) {
      outputAccountError({ message: 'amount must be a positive number.', code: 'invalid_amount' }, globalOpts.json);
    }
    const c = client(globalOpts);
    const spinner = createSpinner('Processing top-up...', globalOpts.quiet);
    const { data, error } = await c.topup(amt);
    if (error) {
      spinner.fail('Top-up failed');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Top-up ready');

    if (isJson(globalOpts)) {
      outputResult(data, { json: true });
      return;
    }
    console.log('');
    if (data!.charged) {
      console.log(
        `  ${pc.green('✓')} ${pc.bold('Added')} ${pc.green(fmtUsd(data!.amount_usd))} ${pc.bold('to your balance')} ${pc.dim('(charged your card on file).')}`,
      );
      console.log('');
      return;
    }
    console.log(`  ${pc.bold('Add')} ${pc.green(fmtUsd(data!.amount_usd))} ${pc.bold('credits - complete payment:')}`);
    console.log('');
    console.log(`    ${pc.cyan(data!.checkout_url)}`);
    console.log('');
    console.log(`  ${pc.dim('Credits land via the Stripe webhook once payment completes.')}`);
    console.log('');
    if (opts.open && data!.checkout_url) await openInBrowser(data!.checkout_url);
  });

// ─── datasets ─────────────────────────────────────────────────────────────────

const datasetsCmd = new Command('datasets')
  .description('Show the datasets this key/org can reach and the tier ladder')
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const c = client(globalOpts);
    const spinner = createSpinner('Loading datasets...', globalOpts.quiet);
    const { data, error } = await c.datasets();
    if (error) {
      spinner.fail('Failed to load datasets');
      outputAccountError(error, globalOpts.json);
    }
    spinner.stop('Datasets loaded');
    const d = data as DatasetsResponse;

    if (isJson(globalOpts)) {
      outputResult(d, { json: true });
      return;
    }
    console.log('');
    console.log(`  ${pc.bold('Tier:')} ${pc.cyan(d.tier)}`);
    console.log(`  ${pc.bold('Available datasets')} ${pc.dim(`(${d.available_datasets.length})`)}`);
    console.log(`    ${d.available_datasets.join(', ')}`);
    console.log('');
    console.log(`  ${pc.bold('Tier ladder')}`);
    for (const t of d.tiers) {
      const marker = t.tier === d.tier ? pc.green(' (current)') : '';
      console.log(`    ${pc.cyan(t.tier.padEnd(7))} ${pc.dim(t.price.padEnd(9))} +${t.adds.join(', ')}${marker}`);
    }
    console.log('');
  });

// ─── group ────────────────────────────────────────────────────────────────────

export const accountCommand = new Command('account')
  .description('Manage your Valyu account: keys, balance, top-ups, datasets')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.cyan('$ valyu account whoami')}
  ${pc.cyan('$ valyu account keys create --name agent --cap 5')}
  ${pc.cyan('$ valyu account keys list')}
  ${pc.cyan('$ valyu account balance')}
  ${pc.cyan('$ valyu account topup 25')}
  ${pc.cyan('$ valyu account datasets')}
`,
  )
  .addCommand(whoamiCmd)
  .addCommand(keysCmd)
  .addCommand(balanceCmd)
  .addCommand(topupCmd)
  .addCommand(datasetsCmd);
