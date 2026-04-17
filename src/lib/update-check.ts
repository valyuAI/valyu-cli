import { detectInstallSource, upgradeCommandFor } from './install-source.js';
import { VERSION } from './version.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@valyu/cli/latest';

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const [la = 0, lb = 0, lc = 0] = latest.split('.').map(Number);
  const [ca = 0, cb = 0, cc = 0] = current.split('.').map(Number);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export async function checkForUpdates(): Promise<void> {
  const latest = await fetchLatestVersion();
  if (!latest || !isNewer(latest, VERSION)) return;
  const upgrade = upgradeCommandFor(detectInstallSource());
  process.stderr.write(
    `\n  Update available: ${VERSION} → ${latest}\n  Run: ${upgrade.command}\n  Or:  valyu upgrade --run\n\n`,
  );
}
