import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey, maskKey } from '../lib/config.js';

describe('resolveApiKey', () => {
  const originalEnv = process.env.VALYU_API_KEY;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let tmpRoot: string;

  // Point the config dir at a fresh empty temp dir so tests are hermetic and
  // never read the developer's real ~/.config/valyu/credentials.json.
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'valyu-cli-test-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    delete process.env.VALYU_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VALYU_API_KEY;
    else process.env.VALYU_API_KEY = originalEnv;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Write a credentials.json into the temp config dir (mimics `valyu login`).
  const writeLogin = (apiKey: string, profile = 'default', active = profile) => {
    const dir = join(tmpRoot, 'valyu');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ active_profile: active, profiles: { [profile]: { api_key: apiKey } } }),
    );
  };

  it('returns flag value when provided', () => {
    const result = resolveApiKey('flag-key-value-here-1234');
    expect(result).toEqual({ key: 'flag-key-value-here-1234', source: 'flag' });
  });

  it('returns env value when VALYU_API_KEY is set and there is no login', () => {
    process.env.VALYU_API_KEY = 'env-key-value-here-5678';
    const result = resolveApiKey(undefined);
    expect(result).toEqual({ key: 'env-key-value-here-5678', source: 'env' });
  });

  it('prefers flag over env var', () => {
    process.env.VALYU_API_KEY = 'env-key';
    const result = resolveApiKey('flag-key-value-here-1234');
    expect(result?.source).toBe('flag');
    expect(result?.key).toBe('flag-key-value-here-1234');
  });

  it('prefers the logged-in key (config) over VALYU_API_KEY', () => {
    // The headline fix: a `valyu login` key must win over an ambient env var so
    // users do not have to unset VALYU_API_KEY.
    writeLogin('val_login_key_1234567890');
    process.env.VALYU_API_KEY = 'env-key-value-here-5678';
    const result = resolveApiKey(undefined);
    expect(result).toEqual({ key: 'val_login_key_1234567890', source: 'config' });
  });

  it('prefers flag over both the logged-in key and the env var', () => {
    writeLogin('val_login_key_1234567890');
    process.env.VALYU_API_KEY = 'env-key-value-here-5678';
    const result = resolveApiKey('flag-key-value-here-1234');
    expect(result).toEqual({ key: 'flag-key-value-here-1234', source: 'flag' });
  });

  it('falls back to env when the requested profile has no stored key', () => {
    writeLogin('val_login_key_1234567890', 'default');
    process.env.VALYU_API_KEY = 'env-key-value-here-5678';
    const result = resolveApiKey(undefined, 'ci');
    expect(result).toEqual({ key: 'env-key-value-here-5678', source: 'env' });
  });

  it('returns null when no flag, no login, and no env var', () => {
    expect(resolveApiKey(undefined)).toBeNull();
  });
});

describe('maskKey', () => {
  it('masks long keys showing first 7 and last 4 chars', () => {
    const key = 'val_test1234567890abcdefghijklmnopqr';
    const masked = maskKey(key);
    expect(masked).toBe('val_tes...opqr');
    expect(masked).not.toContain('Iv46hnPJ');
  });

  it('returns *** for keys of 8 chars or fewer', () => {
    expect(maskKey('short')).toBe('***');
    expect(maskKey('')).toBe('***');
    expect(maskKey('12345678')).toBe('***');
  });

  it('handles 9 char key', () => {
    const result = maskKey('123456789');
    expect(result).toContain('...');
    expect(result.startsWith('1234567')).toBe(true);
  });
});
