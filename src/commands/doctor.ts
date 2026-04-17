import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../lib/client.js';
import { ValyuClient } from '../lib/client.js';
import { maskKey, resolveApiKey } from '../lib/config.js';
import {
  describeInstallSource,
  detectAllInstalls,
  uninstallCommandFor,
} from '../lib/install-source.js';
import { outputResult } from '../lib/output.js';
import { printCheck, createSpinner } from '../lib/spinner.js';
import { isInteractive } from '../lib/tty.js';
import { checkForUpdates } from '../lib/update-check.js';
import { VERSION } from '../lib/version.js';

type CheckStatus = 'pass' | 'warn' | 'fail';
type CheckResult = { name: string; status: CheckStatus; message: string; detail?: string };

async function checkNodeVersion(): Promise<CheckResult> {
  const v = process.version; // e.g. v20.11.0
  const major = parseInt(v.slice(1), 10);
  return major >= 20
    ? { name: 'Node.js', status: 'pass', message: v }
    : {
        name: 'Node.js',
        status: 'warn',
        message: `${v} (requires v20+)`,
        detail: 'Upgrade to Node.js 20 or later',
      };
}

async function checkApiKeyPresence(flagValue?: string): Promise<CheckResult> {
  const resolved = resolveApiKey(flagValue);
  if (!resolved) {
    return {
      name: 'API Key',
      status: 'fail',
      message: 'No API key found',
      detail: 'Run: valyu login',
    };
  }
  return {
    name: 'API Key',
    status: 'pass',
    message: `${maskKey(resolved.key)} (source: ${resolved.source})`,
  };
}

async function checkApiConnectivity(flagValue?: string): Promise<CheckResult> {
  const resolved = resolveApiKey(flagValue);
  if (!resolved) {
    return { name: 'API Connectivity', status: 'fail', message: 'Skipped - no API key' };
  }

  try {
    const client = new ValyuClient(resolved.key);
    const { valid, error } = await client.validateKey();
    if (!valid) {
      return {
        name: 'API Connectivity',
        status: 'fail',
        message: `Key invalid: ${error ?? 'unknown'}`,
        detail: 'Check your API key at platform.valyu.ai',
      };
    }
    return { name: 'API Connectivity', status: 'pass', message: 'Connected to api.valyu.ai' };
  } catch (err) {
    return {
      name: 'API Connectivity',
      status: 'fail',
      message: `Connection failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

export const doctorCommand = new Command('doctor')
  .description('Check CLI setup and API connectivity')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu doctor')}
  ${pc.dim('$ valyu doctor --json')}
`,
  )
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const interactive = isInteractive() && !globalOpts.json;
    const checks: CheckResult[] = [];

    if (interactive) {
      console.log(`\n  ${pc.bold('Valyu Doctor')}\n`);
    }

    // Node.js version
    let spinner = interactive ? createSpinner('Checking Node.js...') : null;
    const nodeCheck = await checkNodeVersion();
    checks.push(nodeCheck);
    if (interactive) {
      spinner?.stop(`Node.js ${nodeCheck.message}`);
    }

    // API key
    spinner = interactive ? createSpinner('Checking API key...') : null;
    const keyCheck = await checkApiKeyPresence(globalOpts.apiKey);
    checks.push(keyCheck);
    if (interactive) {
      if (keyCheck.status === 'fail') spinner?.fail(keyCheck.message);
      else spinner?.stop(keyCheck.message);
    }

    // CLI version
    checks.push({
      name: 'CLI Version',
      status: 'pass',
      message: `v${VERSION}`,
    });

    // Detect shadow installs that can mask the active binary and make
    // upgrades appear to "not take effect".
    const allInstalls = detectAllInstalls();
    if (allInstalls.length > 1) {
      const active = allInstalls.find((i) => i.active);
      const shadows = allInstalls.filter((i) => !i.active);
      const uninstallCmds = shadows
        .map((s) => uninstallCommandFor(s.source))
        .filter((x): x is string => Boolean(x));
      const shadowLines = shadows
        .map((s) => `     ${s.path} [${describeInstallSource(s.source)}]`)
        .join('\n');
      checks.push({
        name: 'Install',
        status: 'warn',
        message: `${allInstalls.length} valyu binaries on PATH - shadows may hide upgrades`,
        detail:
          `Active: ${active?.path ?? '?'} [${active ? describeInstallSource(active.source) : '?'}]` +
          `\n     Shadowed:\n${shadowLines}` +
          (uninstallCmds.length
            ? `\n     Clean up: ${uninstallCmds.join(' ; ')}`
            : ''),
      });
    } else if (allInstalls.length === 1) {
      checks.push({
        name: 'Install',
        status: 'pass',
        message: `${describeInstallSource(allInstalls[0].source)}`,
      });
    }

    // API connectivity
    spinner = interactive ? createSpinner('Testing API connectivity...') : null;
    const connCheck = await checkApiConnectivity(globalOpts.apiKey);
    checks.push(connCheck);
    if (interactive) {
      if (connCheck.status === 'fail') spinner?.fail(connCheck.message);
      else spinner?.stop(connCheck.message);
    }

    const hasFails = checks.some((c) => c.status === 'fail');

    if (globalOpts.json || !interactive) {
      outputResult({ ok: !hasFails, checks }, { json: globalOpts.json });
    } else {
      console.log('');
      for (const check of checks) {
        printCheck(check.status, `${check.name}: ${check.message}`);
        if (check.detail) {
          console.log(`     ${pc.dim(check.detail)}`);
        }
      }
      console.log('');

      if (!hasFails) {
        console.log(`  ${pc.green('Everything looks good!')}`);
      } else {
        console.log(`  ${pc.red('Some checks failed. Run `valyu login` to fix authentication issues.')}`);
      }
      console.log('');

      // Check for updates in background
      checkForUpdates().catch(() => {});
    }

    if (hasFails) process.exit(1);
  });
