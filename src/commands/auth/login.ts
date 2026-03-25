import * as p from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, PLATFORM_URL } from '../../lib/client.js';
import { storeApiKey, getCredentialsPath } from '../../lib/config.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';
import { isInteractive } from '../../lib/tty.js';

const API_KEYS_URL = `${PLATFORM_URL}/user/account/apikeys`;

export const loginCommand = new Command('login')
  .description('Save a Valyu API key')
  .option('--key <key>', 'API key to store (required in non-interactive mode)')
  .option('--profile <name>', 'Profile name to save the key under (default: "default")')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts & { key?: string; profile?: string };
    const profileName = opts.profile ?? globalOpts.profile ?? 'default';
    let apiKey = opts.key?.trim();

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

      p.note(
        `Get your free API key at ${pc.cyan(API_KEYS_URL)}`,
        'Where to get your key',
      );

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
      outputError(
        { message: 'Invalid API key format.', code: 'invalid_key_format' },
        { json: globalOpts.json },
      );
    }

    const spinner = createSpinner('Validating API key...', globalOpts.quiet);

    const client = new ValyuClient(apiKey);
    const { valid, error } = await client.validateKey();

    if (!valid) {
      spinner.fail('API key validation failed');
      outputError(
        { message: error ?? 'Invalid API key', code: 'validation_failed' },
        { json: globalOpts.json },
      );
    }

    spinner.stop('API key is valid');

    const configPath = storeApiKey(apiKey, profileName);

    if (globalOpts.json || !isInteractive()) {
      outputResult(
        { success: true, config_path: configPath, profile: profileName },
        { json: true },
      );
    } else {
      p.outro(`Logged in. API key stored for profile ${pc.cyan(`'${profileName}'`)}`);
    }
  });
