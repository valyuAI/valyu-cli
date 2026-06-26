import * as p from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import type { GlobalOpts } from '../../lib/client.js';
import { AccountClient } from '../../lib/account-client.js';
import {
  removeApiKey,
  listProfiles,
  resolveApiKey,
  getValyuKeyId,
  getActiveProfile,
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
    // the target profile (or the active one). Never blocks logout on a network error.
    let revoked: string | null = null;
    if (opts.revoke) {
      const target = profile ?? getActiveProfile();
      const keyId = getValyuKeyId(target);
      const resolved = resolveApiKey(globalOpts.apiKey, target);
      if (keyId && resolved) {
        try {
          const { data } = await new AccountClient(resolved.key).revokeKey(keyId);
          if (data?.status === 'revoked') revoked = keyId;
        } catch {
          // Ignore - local credentials are removed regardless.
        }
      }
    }

    const removed = removeApiKey(profile);

    if (!removed) {
      outputError(
        { message: profile ? `Profile '${profile}' not found` : 'No credentials found', code: 'not_found' },
        { json: globalOpts.json },
      );
    }

    if (globalOpts.json || !isInteractive()) {
      outputResult({ success: true, profile: profile ?? 'all', revoked }, { json: true });
    } else {
      const suffix = revoked ? ' (key revoked server-side)' : '';
      console.log(
        profile
          ? `  Removed profile '${profile}'${suffix}`
          : `  Logged out. All credentials removed.${suffix}`,
      );
    }
  });
