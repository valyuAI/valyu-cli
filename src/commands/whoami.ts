import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../lib/client.js';
import { getConfigDir, maskKey, resolveApiKey, getActiveProfile } from '../lib/config.js';
import { join } from 'node:path';
import { outputError, outputResult } from '../lib/output.js';
import { isInteractive } from '../lib/tty.js';

export const whoamiCommand = new Command('whoami')
  .description('Show current authentication status')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu whoami')}
  ${pc.dim('$ valyu whoami --json')}
`,
  )
  .action((_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const profileFlag = globalOpts.profile;
    const resolved = resolveApiKey(globalOpts.apiKey, profileFlag);

    if (!resolved) {
      if (globalOpts.json || !isInteractive()) {
        outputResult({ authenticated: false }, { json: globalOpts.json, exitCode: 1 });
        return;
      }
      outputError(
        {
          message: 'Not authenticated.\nRun `valyu login` to get started.',
          code: 'not_authenticated',
        },
        { json: false },
      );
    }

    const profile = profileFlag ?? getActiveProfile();
    const configPath = join(getConfigDir(), 'credentials.json');

    if (globalOpts.json || !isInteractive()) {
      outputResult(
        {
          authenticated: true,
          profile,
          api_key: maskKey(resolved!.key),
          source: resolved!.source,
          config_path: configPath,
        },
        { json: globalOpts.json },
      );
      return;
    }

    const sourceLabel =
      resolved!.source === 'config'
        ? 'config file'
        : resolved!.source === 'env'
          ? 'environment variable (VALYU_API_KEY)'
          : 'flag (--api-key)';

    console.log('');
    console.log(`  ${pc.bold('Profile:')} ${pc.cyan(profile)}`);
    console.log(`  ${pc.bold('API Key:')} ${maskKey(resolved!.key)}`);
    console.log(`  ${pc.bold('Source:')}  ${sourceLabel}`);
    console.log(`  ${pc.bold('Config:')}  ${pc.dim(configPath)}`);
    console.log('');
  });
