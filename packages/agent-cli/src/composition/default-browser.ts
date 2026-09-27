import { execFile } from 'node:child_process';

/** Owner consent opens in the user's browser; no shell interprets the URL. */
export async function openDefaultBrowser(url: string, trustedOrigin: string): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.origin !== trustedOrigin || target.username || target.password) {
    throw new Error('browser target refused');
  }
  const command = process.platform === 'linux' ? 'xdg-open' : process.platform === 'darwin' ? 'open' : null;
  if (command === null) throw new Error('browser unavailable');
  await new Promise<void>((resolve, reject) => {
    execFile(command, [target.href], { timeout: 15_000, windowsHide: true }, error => {
      if (error) reject(new Error('browser unavailable'));
      else resolve();
    });
  });
}
