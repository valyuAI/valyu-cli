import { execFile } from 'node:child_process';

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate and normalize a URL before passing it to an OS browser launcher.
 * Only http: and https: URLs without control characters are allowed.
 */
export function validateBrowserUrl(rawUrl: string): string | null {
  if (!rawUrl || hasControlChars(rawUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

export async function openInBrowser(url: string): Promise<boolean> {
  const safeUrl = validateBrowserUrl(url);
  if (!safeUrl) return false;

  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [safeUrl]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl]]
        : ['xdg-open', [safeUrl]];

  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(!err));
  });
}
