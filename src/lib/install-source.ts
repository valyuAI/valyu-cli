import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter } from 'node:path';

export type InstallSource =
  | { kind: 'homebrew'; path: string }
  | { kind: 'npm-global'; path: string; manager: 'npm' | 'pnpm' | 'yarn' }
  | { kind: 'binary'; path: string; location: 'user-local' | 'system' | 'windows' }
  | { kind: 'dev'; path: string }
  | { kind: 'unknown'; path: string };

// For `pkg`-compiled standalone binaries (Homebrew, the curl installer,
// the Windows PowerShell installer), `process.argv[1]` resolves to a
// virtual snapshot path like `/snapshot/valyu-cli/dist/cli.cjs` that
// lives inside the bundle - useless for install-source detection. The
// real binary path is `process.execPath` in that case.
//
// For Node-script invocations (npm global install, dev via tsx/node),
// `process.execPath` is just `node` itself, so the script path in
// `process.argv[1]` is what we want.
//
// Heuristic: if `process.execPath` has a `valyu`-shaped basename, we're
// running a compiled binary and should trust it. Otherwise fall back
// to argv[1].
function executablePath(): string {
  const exe = process.execPath;
  const exeLower = exe.toLowerCase();
  const looksLikeCompiledBinary =
    exeLower.endsWith('/valyu') ||
    exeLower.endsWith('\\valyu.exe') ||
    exeLower.endsWith('/valyu.exe') ||
    /\/cellar\/valyu\//.test(exeLower);

  if (looksLikeCompiledBinary) {
    try {
      return realpathSync(exe);
    } catch {
      return exe;
    }
  }

  const script = process.argv[1];
  if (!script) return exe;
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

export function detectInstallSource(): InstallSource {
  const path = executablePath();
  const lower = path.toLowerCase();

  if (lower.includes('/homebrew/') || lower.includes('/cellar/valyu/')) {
    return { kind: 'homebrew', path };
  }

  if (lower.includes('/pnpm-global/') || lower.includes('/share/pnpm/') || lower.includes('/.pnpm/')) {
    return { kind: 'npm-global', path, manager: 'pnpm' };
  }

  if (lower.includes('/.yarn/') || lower.includes('/yarn/global/')) {
    return { kind: 'npm-global', path, manager: 'yarn' };
  }

  if (
    lower.includes('/lib/node_modules/@valyu/') ||
    lower.includes('/node_modules/@valyu/cli/') ||
    lower.includes('\\appdata\\roaming\\npm\\') ||
    lower.includes('\\npm\\node_modules\\@valyu\\')
  ) {
    return { kind: 'npm-global', path, manager: 'npm' };
  }

  if (lower.includes('/.local/bin/')) {
    return { kind: 'binary', path, location: 'user-local' };
  }

  if (lower.includes('\\.valyu\\bin\\')) {
    return { kind: 'binary', path, location: 'windows' };
  }

  if (
    (lower.startsWith('/usr/local/bin/') || lower.startsWith('/opt/valyu/')) &&
    !lower.includes('node_modules')
  ) {
    return { kind: 'binary', path, location: 'system' };
  }

  if (
    lower.endsWith('/src/cli.ts') ||
    (lower.endsWith('/dist/cli.cjs') && !lower.includes('node_modules'))
  ) {
    return { kind: 'dev', path };
  }

  return { kind: 'unknown', path };
}

export interface UpgradeCommand {
  command: string;
  note?: string;
}

export function upgradeCommandFor(source: InstallSource): UpgradeCommand {
  switch (source.kind) {
    case 'homebrew':
      return { command: 'brew update && brew upgrade valyu' };
    case 'npm-global':
      if (source.manager === 'pnpm') return { command: 'pnpm add -g @valyu/cli@latest' };
      if (source.manager === 'yarn') return { command: 'yarn global add @valyu/cli@latest' };
      return { command: 'npm install -g @valyu/cli@latest' };
    case 'binary':
      if (source.location === 'windows') {
        return {
          command: 'iwr https://get.valyu.ai/install.ps1 -UseBasicParsing | iex',
        };
      }
      return {
        command: 'curl -fsSL https://get.valyu.ai | bash',
      };
    case 'dev':
      return {
        command: 'git pull && pnpm install && pnpm build',
        note: 'Running from a dev checkout',
      };
    default:
      return {
        command: 'npm install -g @valyu/cli@latest',
        note: "Couldn't detect install source - npm is a safe default. If you used Homebrew, run `brew upgrade valyu` instead.",
      };
  }
}

export function describeInstallSource(source: InstallSource): string {
  switch (source.kind) {
    case 'homebrew':
      return 'Homebrew';
    case 'npm-global':
      return `${source.manager} global`;
    case 'binary':
      return source.location === 'windows'
        ? 'Standalone binary (Windows installer)'
        : source.location === 'user-local'
          ? 'Standalone binary (~/.local/bin)'
          : 'Standalone binary (system)';
    case 'dev':
      return 'Dev checkout';
    default:
      return 'Unknown';
  }
}

// Find every `valyu` on PATH and classify each one. Lets us warn about shadow
// installs that make upgrades look broken (e.g. stale binary in ~/.local/bin
// still winning over a newer Homebrew install because PATH order).
export interface InstallLocation {
  path: string;
  source: InstallSource;
  active: boolean;
}

function activeExecutablePath(): string {
  return executablePath();
}

export function detectAllInstalls(): InstallLocation[] {
  if (process.platform === 'win32') return [];
  const active = activeExecutablePath();
  const found: string[] = [];

  const addResolved = (p: string) => {
    try {
      const resolved = realpathSync(p);
      if (!found.includes(resolved)) found.push(resolved);
    } catch {
      if (!found.includes(p)) found.push(p);
    }
  };

  try {
    const out = execFileSync('/usr/bin/which', ['-a', 'valyu'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      addResolved(line);
    }
  } catch {
    for (const p of (process.env.PATH ?? '').split(delimiter)) {
      if (p) addResolved(`${p}/valyu`);
    }
  }

  if (!found.includes(active)) found.unshift(active);

  return found.map((path) => ({
    path,
    source: classifyPath(path),
    active: path === active,
  }));
}

function classifyPath(path: string): InstallSource {
  const lower = path.toLowerCase();
  if (lower.includes('/homebrew/') || lower.includes('/cellar/valyu/')) {
    return { kind: 'homebrew', path };
  }
  if (lower.includes('/pnpm-global/') || lower.includes('/share/pnpm/') || lower.includes('/.pnpm/')) {
    return { kind: 'npm-global', path, manager: 'pnpm' };
  }
  if (lower.includes('/.yarn/') || lower.includes('/yarn/global/')) {
    return { kind: 'npm-global', path, manager: 'yarn' };
  }
  if (
    lower.includes('/lib/node_modules/@valyu/') ||
    lower.includes('/node_modules/@valyu/cli/')
  ) {
    return { kind: 'npm-global', path, manager: 'npm' };
  }
  if (lower.includes('/.local/bin/')) {
    return { kind: 'binary', path, location: 'user-local' };
  }
  if (lower.startsWith('/usr/local/bin/') || lower.startsWith('/opt/valyu/')) {
    return { kind: 'binary', path, location: 'system' };
  }
  if (lower.endsWith('/dist/cli.cjs') && !lower.includes('node_modules')) {
    return { kind: 'dev', path };
  }
  return { kind: 'unknown', path };
}

export function uninstallCommandFor(source: InstallSource): string | null {
  switch (source.kind) {
    case 'homebrew':
      return 'brew uninstall valyu';
    case 'npm-global':
      if (source.manager === 'pnpm') return 'pnpm remove -g @valyu/cli';
      if (source.manager === 'yarn') return 'yarn global remove @valyu/cli';
      return 'npm uninstall -g @valyu/cli';
    case 'binary':
      return source.location === 'windows' ? null : `rm ${source.path}`;
    default:
      return null;
  }
}
