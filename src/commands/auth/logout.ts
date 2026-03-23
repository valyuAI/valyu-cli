import * as p from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import type { GlobalOpts } from '../../lib/client.js';
import { removeApiKey, listProfiles } from '../../lib/config.js';
import { outputError, outputResult } from '../../lib/output.js';
import { isInteractive } from '../../lib/tty.js';

export const logoutCommand = new Command('logout')
  .description('Remove stored API key')
  .option('--profile <name>', 'Profile to remove (default: all profiles)')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts & {
      profile?: string;
      yes?: boolean;
    };
    const profile = opts.profile ?? globalOpts.profile;

    if (!opts.yes && isInteractive() && !globalOpts.json) {
      const profiles = listProfiles();
      const what = profile
        ? `profile '${profile}'`
        : `all ${profiles.length} profile(s): ${profiles.join(', ')}`;
      const confirmed = await p.confirm({
        message: `Remove ${what}?`,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel('Logout cancelled.');
        process.exit(0);
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
      outputResult({ success: true, profile: profile ?? 'all' }, { json: true });
    } else {
      console.log(profile ? `  Removed profile '${profile}'` : '  Logged out. All credentials removed.');
    }
  });
