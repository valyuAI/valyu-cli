// Shared parsers for CLI option values. Each throws an Error whose message is
// ready to show the user.

export function parseSourceBiases(entries: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  for (const kv of entries) {
    const eq = kv.lastIndexOf('=');
    if (eq <= 0) {
      throw new Error(
        `Invalid --source-bias '${kv}'. Expected <domain>=<bias> with bias an integer from -5 to +5, e.g. arxiv.org=5 or reddit.com=-4`,
      );
    }
    const key = kv.slice(0, eq).trim();
    const bias = Number(kv.slice(eq + 1).trim());
    if (!key || /\s/.test(key)) {
      throw new Error(`Invalid --source-bias '${kv}'. Use a domain or URL prefix with no spaces.`);
    }
    if (seen.has(key.toLowerCase())) {
      throw new Error(`--source-bias names '${key}' twice (sources are case-insensitive). Give each source one bias.`);
    }
    if (!Number.isInteger(bias) || bias < -5 || bias > 5) {
      throw new Error(`Invalid --source-bias '${kv}'. Bias must be an integer between -5 and +5.`);
    }
    seen.add(key.toLowerCase());
    out[key] = bias;
  }
  return out;
}

export function parseIntOption(value: string, flag: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be a whole number from ${min} to ${max} (got '${value}').`);
  }
  return n;
}

export function parseDate(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${flag} must be a date formatted YYYY-MM-DD (got '${value}'), e.g. 2026-01-15.`);
  }
  return value;
}

export function parseCountry(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-z]{2}$/i.test(value)) {
    throw new Error(`--country must be a two-letter ISO 3166-1 code, e.g. GB or US (got '${value}').`);
  }
  return value.toUpperCase();
}

/**
 * Repeatable key=value pairs. `true`/`false` and numbers that round-trip
 * exactly are coerced; anything else stays a string, so an identifier with a
 * leading zero (a CIK, a ticker like 0700) is not turned into a number.
 */
export function parseKeyValues(pairs: string[], flag: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of pairs) {
    const eq = kv.indexOf('=');
    const key = eq > 0 ? kv.slice(0, eq).trim() : '';
    if (!key) throw new Error(`Invalid ${flag} '${kv}'. Expected key=value.`);
    const raw = kv.slice(eq + 1);
    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw !== '' && String(Number(raw)) === raw) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}
