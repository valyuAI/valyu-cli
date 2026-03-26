import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ApiKeySource = 'flag' | 'env' | 'config';
export type ResolvedKey = { key: string; source: ApiKeySource };

export type CredentialsFile = {
  api_key?: string;
  active_profile: string;
  profiles: Record<string, { api_key?: string }>;
};

export function getConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'valyu');
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'valyu');
  }
  return join(homedir(), '.config', 'valyu');
}

export function getCredentialsPath(): string {
  return join(getConfigDir(), 'credentials.json');
}

export function readCredentials(): CredentialsFile | null {
  try {
    const raw = readFileSync(getCredentialsPath(), 'utf-8');
    const data = JSON.parse(raw) as CredentialsFile;
    // Legacy format: { api_key: "val_xxx" }
    if (data.api_key && !data.profiles) {
      return {
        active_profile: 'default',
        profiles: { default: { api_key: data.api_key } },
      };
    }
    return data;
  } catch {
    return null;
  }
}

export function writeCredentials(data: CredentialsFile): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getCredentialsPath(), JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

export function resolveApiKey(flagValue?: string, profile?: string): ResolvedKey | null {
  if (flagValue) return { key: flagValue, source: 'flag' };
  if (process.env.VALYU_API_KEY) return { key: process.env.VALYU_API_KEY, source: 'env' };

  const creds = readCredentials();
  if (!creds) return null;

  const profileName = profile ?? creds.active_profile ?? 'default';
  const p = creds.profiles[profileName];
  if (p?.api_key) return { key: p.api_key, source: 'config' };

  return null;
}

export function storeApiKey(apiKey: string, profile = 'default'): string {
  const existing = readCredentials() ?? { active_profile: 'default', profiles: {} };
  existing.profiles[profile] = { api_key: apiKey };
  existing.active_profile = profile;
  writeCredentials(existing);
  return getCredentialsPath();
}

export function removeApiKey(profile?: string): boolean {
  const creds = readCredentials();
  if (!creds) return false;

  if (profile) {
    if (!creds.profiles[profile]) return false;
    delete creds.profiles[profile];
    if (creds.active_profile === profile) {
      const remaining = Object.keys(creds.profiles);
      creds.active_profile = remaining[0] ?? 'default';
    }
    writeCredentials(creds);
    return true;
  }

  // Remove all
  try {
    unlinkSync(getCredentialsPath());
    return true;
  } catch {
    return false;
  }
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export function listProfiles(): string[] {
  const creds = readCredentials();
  if (!creds) return [];
  return Object.keys(creds.profiles);
}

export function getActiveProfile(): string {
  return readCredentials()?.active_profile ?? 'default';
}
