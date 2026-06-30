import * as p from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import { AccountClient } from '../../lib/account-client.js';
import type { GlobalOpts } from '../../lib/client.js';
import {
  getActiveProfile,
  getValyuKeyId,
  listProfiles,
  removeApiKey,
  resolveApiKey,
} from '../../lib/config.js';
import { outputError, outputResult } from '../../lib/output.js';
import { isInteractive } from '../../lib/tty.js';

export const logoutCommand = new Command('logout')
  .description('Remove stored credentials locally (use --revoke to also kill the key server-side)')
  .option('--profile <name>', 'Profile to remove (default: all profiles)')
  .option('--revoke', 'Also revoke the device-minted key server-side (best-effort)')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts & {
      profile?: string;
      revoke?: boolean;
      yes?: boolean;
    };
    const profile = opts.profile ?? globalOpts.profile;

    if (!opts.yes && isInteractive() && !globalOpts.json) {
      const profiles = listProfiles();
      const what = profile
        ? `profile '${profile}'`
        : `all ${profiles.length} profile(s): ${profiles.join(', ')}`;
      const confirmed = await p.confirm({ message: `Remove ${what}?` });
      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel('Logout cancelled.');
        process.exit(0);
      }
    }

    // By default logout only forgets local credentials (like gh/aws/docker).
    // With --revoke, also kill the key minted by `valyu login` server-side for
    // the target profile (or the active one). Never blocks logout on a network
    // error, but the revoke OUTCOME is always surfaced (not swallowed) — this is
    // the command used to kill a leaked key, so a silent failure is dangerous.
    // revoke_status: 'revoked' | 'failed' | 'skipped' | 'not_requested'.
    let revoked: string | null = null;
    let revokeStatus: 'revoked' | 'failed' | 'skipped' | 'not_requested' = 'not_requested';
    let revokeError: string | null = null;
    if (opts.revoke) {
      const target = profile ?? getActiveProfile();
      const keyId = getValyuKeyId(target);
      const resolved = resolveApiKey(globalOpts.apiKey, target);
      if (!keyId || !resolved) {
        // No device-minted key id stored (e.g. a `--key` login) — nothing to
        // revoke server-side. Report it rather than implying success.
        revokeStatus = 'skipped';
        revokeError = !keyId
          ? 'no stored valyu_key_id for this profile (not a device-minted login)'
          : 'no API key available to authenticate the revoke call';
      } else {
        try {
          const { data } = await new AccountClient(resolved.key).revokeKey(keyId);
          if (data?.status === 'revoked') {
            revoked = keyId;
            revokeStatus = 'revoked';
          } else {
            revokeStatus = 'failed';
            revokeError = `server did not confirm revocation (status: ${data?.status ?? 'unknown'})`;
          }
        } catch (err) {
          // Do NOT block logout, but surface the failure — the key may still be live.
          revokeStatus = 'failed';
          revokeError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const removed = removeApiKey(profile);

    if (!removed) {
      outputError(
        {
          message: profile ? `Profile '${profile}' not found` : 'No credentials found',
          code: 'not_found',
        },
        { json: globalOpts.json },
      );
    }

    if (globalOpts.json || !isInteractive()) {
      outputResult(
        {
          success: true,
          profile: profile ?? 'all',
          revoked,
          revoke_status: revokeStatus,
          revoke_error: revokeError,
        },
        { json: true },
      );
    } else {
      const suffix = revoked ? ' (key revoked server-side)' : '';
      console.log(
        profile
          ? `  Removed profile '${profile}'${suffix}`
          : `  Logged out. All credentials removed.${suffix}`,
      );
      // Surface a non-success revoke outcome explicitly — never let --revoke
      // imply the key is dead when it might still be live.
      if (opts.revoke && revokeStatus === 'failed') {
        console.error(
          `  WARNING: server-side key revocation FAILED${revokeError ? ` (${revokeError})` : ''}.`,
        );
        console.error(
          '  The key may still be active — revoke it manually with `valyu keys revoke`.',
        );
      } else if (opts.revoke && revokeStatus === 'skipped') {
        console.error(
          `  WARNING: --revoke was requested but skipped${revokeError ? ` (${revokeError})` : ''}.`,
        );
        console.error('  Local credentials were removed, but no key was revoked server-side.');
      }
    }
  });
