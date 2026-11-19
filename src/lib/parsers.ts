// Shared parsers for CLI option values

export function parseSourceBiases(entries: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of entries) {
    const eq = kv.lastIndexOf('=');
    if (eq <= 0) {
      throw new Error(
        `Invalid --source-bias '${kv}'. Expected format: <domain>=<bias> where bias is an integer from -5 to +5 (e.g. arxiv.org=5, reddit.com=-4)`,
      );
    }
    const key = kv.slice(0, eq).trim();
    const rawBias = kv.slice(eq + 1).trim();
    if (!key) throw new Error(`Invalid --source-bias '${kv}'. Empty domain.`);
    const n = Number(rawBias);
    if (!Number.isInteger(n) || n < -5 || n > 5) {
      throw new Error(
        `Invalid --source-bias '${kv}'. Bias must be an integer between -5 and +5.`,
      );
    }
    out[key] = n;
  }
  return out;
}

export function parseResponseLength(value: string | undefined): string | number | undefined {
  if (value == null) return undefined;
  if (['short', 'medium', 'large', 'max'].includes(value)) return value;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  throw new Error(
    `Invalid --response-length '${value}'. Expected: short, medium, large, max, or a positive integer.`,
  );
}

const VERSION_FLAGS = ['-v', '--version'];
const ROOT_VALUE_OPTIONS = ['--api-key', '-p', '--profile'];

/**
 * True when `-v` / `--version` is a root flag (`valyu --version`), i.e. it comes
 * before any subcommand. After a subcommand it belongs to that subcommand, as
 * in `valyu deepresearch status <id> --version 2`.
 */
export function isRootVersionRequest(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VERSION_FLAGS.includes(arg)) return true;
    if (ROOT_VALUE_OPTIONS.includes(arg)) i++;
    else if (!arg.startsWith('-')) return false;
  }
  return false;
}
