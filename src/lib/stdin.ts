/**
 * Read from stdin if data is being piped (non-TTY).
 * Returns null if stdin is a TTY (interactive) or empty.
 */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  return text || null;
}
