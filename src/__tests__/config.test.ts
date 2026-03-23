import { describe, it, expect, afterEach } from 'vitest';
import { resolveApiKey, maskKey } from '../lib/config.js';

describe('resolveApiKey', () => {
  const originalEnv = process.env.VALYU_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VALYU_API_KEY;
    } else {
      process.env.VALYU_API_KEY = originalEnv;
    }
  });

  it('returns flag value when provided', () => {
    delete process.env.VALYU_API_KEY;
    const result = resolveApiKey('flag-key-value-here-1234');
    expect(result).toEqual({ key: 'flag-key-value-here-1234', source: 'flag' });
  });

  it('returns env value when VALYU_API_KEY is set', () => {
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
});

describe('maskKey', () => {
  it('masks long keys showing first 7 and last 4 chars', () => {
    const key = 'rTtuJvaSIv46hnPJkVmxp80Svx4YOf6U4yfteuEk';
    const masked = maskKey(key);
    expect(masked).toBe('rTtuJva...euEk');
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
