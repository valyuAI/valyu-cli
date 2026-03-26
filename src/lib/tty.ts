export const isUnicodeSupported =
  process.platform !== 'win32' ||
  Boolean(process.env.CI) ||
  Boolean(process.env.WT_SESSION) ||
  Boolean(process.env.TERM_PROGRAM === 'vscode') ||
  process.env.TERM === 'xterm-256color' ||
  process.env.TERM === 'alacritty';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
