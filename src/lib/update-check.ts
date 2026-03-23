import { VERSION } from './version.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@valyu/cli/latest';

export async function checkForUpdates(): Promise<void> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest || latest === VERSION) return;

    // Simple semver comparison
    const [maj, min, pat] = VERSION.split('.').map(Number);
    const [lmaj, lmin, lpat] = latest.split('.').map(Number);
    const isNewer =
      lmaj > maj || (lmaj === maj && lmin > min) || (lmaj === maj && lmin === min && lpat > pat);

    if (isNewer) {
      process.stderr.write(
        `\n  Update available: ${VERSION} → ${latest}\n  Run: npm install -g @valyu/cli\n\n`,
      );
    }
  } catch {
    // Silently ignore update check failures
  }
}
