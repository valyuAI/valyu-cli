import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

async function loadBrowser() {
  vi.resetModules();
  return import('../lib/browser.js');
}

describe('validateBrowserUrl', () => {
  it('accepts valid https and http URLs and returns normalized href', async () => {
    const { validateBrowserUrl } = await loadBrowser();
    expect(validateBrowserUrl('https://platform.valyu.ai/oauth?code=123')).toBe(
      'https://platform.valyu.ai/oauth?code=123',
    );
    expect(validateBrowserUrl('http://localhost:3000/callback')).toBe(
      'http://localhost:3000/callback',
    );
  });

  it('rejects non-http(s) schemes, malformed strings, and control characters', async () => {
    const { validateBrowserUrl } = await loadBrowser();
    expect(validateBrowserUrl('')).toBeNull();
    expect(validateBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(validateBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(validateBrowserUrl('smb://evil.example/share')).toBeNull();
    expect(validateBrowserUrl('ms-msdt:/id PCWDiagnostic')).toBeNull();
    expect(validateBrowserUrl('--option')).toBeNull();
    expect(validateBrowserUrl('https://platform.valyu.ai\ncalc.exe')).toBeNull();
    expect(validateBrowserUrl('https://platform.valyu.ai\r\n')).toBeNull();
    expect(validateBrowserUrl('https://platform.valyu.ai/\x00')).toBeNull();
  });
});

describe('openInBrowser', () => {
  const origPlatform = process.platform;

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  it('rejects unsafe URLs without spawning a child process', async () => {
    const { openInBrowser } = await loadBrowser();
    expect(await openInBrowser('file:///etc/passwd')).toBe(false);
    expect(await openInBrowser('javascript:alert(1)')).toBe(false);
    expect(await openInBrowser('https://valyu.ai/$(whoami)\n')).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('uses open on darwin for valid https URLs', async () => {
    setPlatform('darwin');
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null));
    const { openInBrowser } = await loadBrowser();

    const ok = await openInBrowser('https://platform.valyu.ai/login');
    expect(ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'open',
      ['https://platform.valyu.ai/login'],
      expect.any(Function),
    );
  });

  it('uses rundll32.exe url.dll,FileProtocolHandler on win32 instead of shell builtin start', async () => {
    setPlatform('win32');
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null));
    const { openInBrowser } = await loadBrowser();

    const ok = await openInBrowser('https://platform.valyu.ai/login?a=1&b=2');
    expect(ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', 'https://platform.valyu.ai/login?a=1&b=2'],
      expect.any(Function),
    );
  });

  it('uses xdg-open on linux and returns false if execFile errors', async () => {
    setPlatform('linux');
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error('ENOENT')));
    const { openInBrowser } = await loadBrowser();

    const ok = await openInBrowser('https://platform.valyu.ai');
    expect(ok).toBe(false);
    expect(execFileMock).toHaveBeenCalledWith(
      'xdg-open',
      ['https://platform.valyu.ai/'],
      expect.any(Function),
    );
  });
});
