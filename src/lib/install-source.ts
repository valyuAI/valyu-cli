import { realpathSync } from 'node:fs';

export type InstallSource =
  | { kind: 'homebrew'; path: string }
  | { kind: 'npm-global'; path: string; manager: 'npm' | 'pnpm' | 'yarn' }
  | { kind: 'binary'; path: string; location: 'user-local' | 'system' | 'windows' }
  | { kind: 'dev'; path: string }
  | { kind: 'unknown'; path: string };

function executablePath(): string {
  const script = process.argv[1];
  if (!script) return process.execPath;
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
          command:
            'iwr https://raw.githubusercontent.com/valyuAI/valyu-cli/main/install.ps1 -UseBasicParsing | iex',
        };
      }
      return {
        command:
          'curl -fsSL https://raw.githubusercontent.com/valyuAI/valyu-cli/main/install.sh | bash',
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
