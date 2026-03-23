import { exec } from 'node:child_process';

export async function openInBrowser(url: string): Promise<boolean> {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    exec(`${opener} "${url}"`, (err) => resolve(!err));
  });
}
