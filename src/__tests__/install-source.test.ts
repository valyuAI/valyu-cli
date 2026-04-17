import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The function under test depends on process.argv + process.execPath.
// We import fresh each test so any module-level caching (none today, but
// future-proof) doesn't leak between scenarios.
async function loadDetect() {
  vi.resetModules();
  const mod = await import('../lib/install-source.js');
  return mod.detectInstallSource;
}

describe('detectInstallSource', () => {
  let origArgv: string[];
  let origExecPath: string;

  beforeEach(() => {
    origArgv = process.argv;
    origExecPath = process.execPath;
  });

  afterEach(() => {
    process.argv = origArgv;
    Object.defineProperty(process, 'execPath', { value: origExecPath, configurable: true });
  });

  function setExec(path: string) {
    Object.defineProperty(process, 'execPath', { value: path, configurable: true });
  }

  it('classifies a pkg-bundled Homebrew binary via process.execPath even when argv[1] is a /snapshot/ path', async () => {
    setExec('/opt/homebrew/Cellar/valyu/1.0.6/bin/valyu');
    process.argv = ['/opt/homebrew/Cellar/valyu/1.0.6/bin/valyu', '/snapshot/valyu-cli/dist/cli.cjs'];
    const detect = await loadDetect();
    const src = detect();
    expect(src.kind).toBe('homebrew');
  });

  it('classifies a standalone user-local binary via process.execPath', async () => {
    setExec('/Users/example/.local/bin/valyu');
    process.argv = ['/Users/example/.local/bin/valyu', '/snapshot/valyu-cli/dist/cli.cjs'];
    const detect = await loadDetect();
    const src = detect();
    expect(src.kind).toBe('binary');
    if (src.kind === 'binary') expect(src.location).toBe('user-local');
  });

  it('classifies an npm global install via argv[1] (execPath is node, not valyu)', async () => {
    setExec('/usr/local/bin/node');
    process.argv = [
      '/usr/local/bin/node',
      '/usr/local/lib/node_modules/@valyu/cli/dist/cli.cjs',
    ];
    const detect = await loadDetect();
    const src = detect();
    expect(src.kind).toBe('npm-global');
    if (src.kind === 'npm-global') expect(src.manager).toBe('npm');
  });

  it('falls back to "unknown" for paths that do not match any known install', async () => {
    setExec('/usr/local/bin/node');
    process.argv = ['/usr/local/bin/node', '/some/random/place/cli.cjs'];
    const detect = await loadDetect();
    const src = detect();
    expect(src.kind).toBe('unknown');
  });
});
