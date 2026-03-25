import pc from 'picocolors';

export function relTime(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (Number.isNaN(d)) return '';
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  running: pc.yellow,
  queued: pc.yellow,
  awaiting_input: pc.yellow,
  paused: pc.yellow,
  completed: pc.green,
  failed: pc.red,
  cancelled: pc.dim,
};

export function colorStatus(s: string): string {
  return (STATUS_COLOR[s] ?? pc.white)(s);
}
