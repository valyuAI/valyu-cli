import {
  chmodSync,
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

export type ProfileEntry = { api_key?: string; valyu_key_id?: string };

export type CredentialsFile = {
  api_key?: string;
  active_profile: string;
  profiles: Record<string, ProfileEntry>;
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = getCredentialsPath();
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // mode on writeFileSync only applies on CREATE; re-assert 0o600 every write so a
  // pre-existing looser-permissioned file (legacy build / out-of-band) is tightened.
  try {
    chmodSync(path, 0o600);
    chmodSync(dir, 0o700);
  } catch {
    // best-effort (e.g. Windows) - the plaintext key write already succeeded.
  }
}

export function resolveApiKey(flagValue?: string, profile?: string): ResolvedKey | null {
  // Precedence: explicit flag > local login (config) > ambient VALYU_API_KEY env.
  //
  // A `valyu login` is a stronger, deliberate signal of intent than an ambient
  // env var, so the logged-in key wins - otherwise a user who already has
  // VALYU_API_KEY set would run `valyu login`, mint a scoped key, and silently
  // keep using the old env-var key. The env var stays as the fallback for the
  // no-login case (CI, unauthenticated), so those flows are unchanged. `--api-key`
  // remains the ultimate override for one-off / scripted use.
  if (flagValue) return { key: flagValue, source: 'flag' };

  const creds = readCredentials();
  if (creds) {
    const profileName = profile ?? creds.active_profile ?? 'default';
    const p = creds.profiles[profileName];
    if (p?.api_key) return { key: p.api_key, source: 'config' };
  }

  if (process.env.VALYU_API_KEY) return { key: process.env.VALYU_API_KEY, source: 'env' };

  return null;
}

export function storeApiKey(apiKey: string, profile = 'default', valyuKeyId?: string): string {
  const existing = readCredentials() ?? { active_profile: 'default', profiles: {} };
  const prev = existing.profiles[profile] ?? {};
  existing.profiles[profile] = { ...prev, api_key: apiKey };
  // Track the server-side key id so `valyu logout` can revoke it. Only set when
  // provided; manual `--key` logins won't know it, and that's fine.
  if (valyuKeyId !== undefined) {
    existing.profiles[profile].valyu_key_id = valyuKeyId;
  } else {
    delete existing.profiles[profile].valyu_key_id;
  }
  existing.active_profile = profile;
  writeCredentials(existing);
  return getCredentialsPath();
}

export function getValyuKeyId(profile?: string): string | undefined {
  const creds = readCredentials();
  if (!creds) return undefined;
  const name = profile ?? creds.active_profile ?? 'default';
  return creds.profiles[name]?.valyu_key_id;
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
