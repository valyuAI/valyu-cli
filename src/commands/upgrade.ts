import { spawn } from 'node:child_process';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import type { GlobalOpts } from '../lib/client.js';
import {
  describeInstallSource,
  detectAllInstalls,
  detectInstallSource,
  uninstallCommandFor,
  upgradeCommandFor,
} from '../lib/install-source.js';
import { outputResult } from '../lib/output.js';
import { fetchLatestVersion } from '../lib/update-check.js';
import { VERSION } from '../lib/version.js';

interface UpgradeOpts {
  run?: boolean;
  yes?: boolean;
}

function semverIsNewer(latest: string, current: string): boolean {
  const [la = 0, lb = 0, lc = 0] = latest.split('.').map(Number);
  const [ca = 0, cb = 0, cc = 0] = current.split('.').map(Number);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

async function runShellCommand(command: string): Promise<number> {
  return new Promise((res) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('close', (code) => res(code ?? 1));
  });
}

export const upgradeCommand = new Command('upgrade')
  .description('Upgrade the Valyu CLI to the latest version')
  .option('--run', 'Execute the upgrade command directly (otherwise just prints it)')
  .option('-y, --yes', 'Skip confirmation when using --run')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu upgrade          # print the right upgrade command for your install')}
  ${pc.dim('$ valyu upgrade --run    # execute the upgrade (with confirmation)')}
  ${pc.dim('$ valyu upgrade --run -y # execute without confirmation (for scripts)')}
`,
  )
  .action(async (opts: UpgradeOpts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const source = detectInstallSource();
    const upgrade = upgradeCommandFor(source);
    const latest = await fetchLatestVersion();
    const hasUpdate = latest ? semverIsNewer(latest, VERSION) : null;
    const allInstalls = detectAllInstalls();
    const shadows = allInstalls.filter((i) => !i.active);

    if (globalOpts.json) {
      outputResult(
        {
          current: VERSION,
          latest,
          update_available: hasUpdate,
          install_source: source.kind,
          install_path: source.path,
          upgrade_command: upgrade.command,
          note: upgrade.note,
          installs: allInstalls.map((i) => ({
            path: i.path,
            source: i.source.kind,
            active: i.active,
            uninstall: uninstallCommandFor(i.source),
          })),
          shadow_installs: shadows.length,
        },
        { json: true },
      );
      return;
    }

    console.log('');
    console.log(`  ${pc.bold('Valyu CLI Upgrade')}`);
    console.log('');
    console.log(`  ${pc.bold('Current:')}       v${VERSION}`);
    if (latest) {
      const tag = hasUpdate ? pc.green(`v${latest} (update available)`) : pc.dim(`v${latest} (up to date)`);
      console.log(`  ${pc.bold('Latest:')}        ${tag}`);
    }
    console.log(`  ${pc.bold('Install source:')} ${describeInstallSource(source)}`);
    if (source.kind === 'unknown') {
      console.log(`  ${pc.dim(source.path)}`);
    }
    if (upgrade.note) console.log(`  ${pc.dim(upgrade.note)}`);

    if (allInstalls.length > 1) {
      console.log('');
      console.log(`  ${pc.yellow('\u26a0')}  ${pc.bold('Multiple valyu installs detected on PATH:')}`);
      for (const loc of allInstalls) {
        const mark = loc.active ? pc.green('\u2713 active') : pc.dim('shadowed');
        const kind = describeInstallSource(loc.source);
        console.log(`     ${mark}  ${loc.path}  ${pc.dim(`[${kind}]`)}`);
      }
      console.log('');
      console.log(`  ${pc.dim('Upgrading only the active install may leave older shadow copies ahead on PATH.')}`);
      console.log(`  ${pc.dim('Clean up shadows so the upgraded binary is what runs:')}`);
      for (const loc of shadows) {
        const cmd = uninstallCommandFor(loc.source);
        if (cmd) console.log(`     ${pc.cyan(cmd)}`);
      }
    }

    console.log('');
    console.log(`  ${pc.bold('Run:')}  ${pc.cyan(upgrade.command)}`);
    console.log('');

    if (latest && !hasUpdate && shadows.length === 0) {
      console.log(`  ${pc.green('Already on the latest version.')}`);
      console.log('');
      return;
    }

    if (!opts.run) {
      return;
    }

    if (!opts.yes && process.stdout.isTTY) {
      const go = await p.confirm({ message: `Run: ${upgrade.command}?` });
      if (p.isCancel(go) || !go) {
        console.log(`  ${pc.dim('Cancelled')}`);
        return;
      }
    }

    const code = await runShellCommand(upgrade.command);
    if (code !== 0) {
      console.log('');
      console.log(`  ${pc.red(`Upgrade command exited with code ${code}`)}`);
      process.exit(code);
    }

    console.log('');
    console.log(`  ${pc.green('Upgrade complete.')} Run ${pc.cyan('valyu --version')} to confirm.`);
    console.log('');
  });
