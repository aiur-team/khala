import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { validateCryptoToken, restoredCredentials } from './crypto-store';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), 'khala-1246-crypto-')); roots.push(value); return value; }
async function restart(root: string, device = 'DEVICE', wipe = false) {
  const result = await exec(process.execPath, ['--import', 'tsx', 'fixtures/crypto-store/restart.ts', root, device, wipe ? 'wipe' : 'keep'], { cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  expect(result.stdout).not.toContain('private-token');
  return JSON.parse(result.stdout) as { keys: { ed25519: string; curve25519: string }; savedToken: string | null; restored: boolean; dir: string };
}
it('retains Rust device keys and the sync position across fresh Node processes', async () => {
  const dir = await root();
  const first = await restart(dir);
  const second = await restart(dir);
  expect(first.restored).toBe(false); expect(second.restored).toBe(true);
  expect(second.keys).toEqual(first.keys); expect(second.savedToken).toBe('offline-position');
  expect(JSON.parse(await readFile(path.join(first.dir, 'crypto.json'), 'utf8'))).toEqual({ homeserver: 'https://matrix.test', userId: '@agent:test', deviceId: 'DEVICE', accessToken: 'private-token' });
  if (process.platform !== 'win32') {
    expect((await stat(first.dir)).mode & 0o777).toBe(0o700);
    for (const name of ['crypto.sqlite', 'sync.sqlite', 'crypto.json']) expect((await stat(path.join(first.dir, name))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, 'khala/crypto-index.sqlite'))).mode & 0o777).toBe(0o600);
  }
}, 20_000);
it('wipes keys and sync state on revocation and isolates a replacement device', async () => {
  const dir = await root();
  const first = await restart(dir, 'DEVICE', true);
  expect(await readdir(first.dir)).not.toContain('crypto.sqlite');
  expect(await readdir(first.dir)).not.toContain('sync.sqlite');
  expect(await readdir(first.dir)).not.toContain('crypto.json');
  const second = await restart(dir);
  expect(second.keys).not.toEqual(first.keys); expect(second.savedToken).toBeNull();
  const replacement = await restart(dir, 'REPLACEMENT');
  expect(replacement.restored).toBe(false); expect(replacement.keys).not.toEqual(second.keys); expect(replacement.savedToken).toBeNull();
}, 20_000);
it.skipIf(process.platform === 'win32')('rejects a symlink or a readable secret database', async () => {
  const dir = await root(); const first = await restart(dir);
  const file = path.join(first.dir, 'crypto.sqlite');
  await rm(file); await symlink(path.join(first.dir, 'sync.sqlite'), file);
  await expect(restart(dir)).rejects.toThrow();
  await rm(file); await writeFile(file, '', { mode: 0o644 });
  await expect(restart(dir)).rejects.toThrow();
}, 20_000);


it.each([[200, 'valid'], [401, 'revoked'], [503, 'unavailable']] as const)('checks the persisted token before restore (%i)', async (status, expected) => {
  const dir = await root();
  await writeFile(path.join(dir, 'crypto.json'), JSON.stringify({ homeserver: 'https://matrix.test', userId: '@agent:test', deviceId: 'D', accessToken: 'secret' }), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ user_id: '@agent:test', device_id: 'D' }, { status }));
  expect(await validateCryptoToken(dir, fetcher)).toBe(expected);
  expect(fetcher).toHaveBeenCalledWith('https://matrix.test/_matrix/client/v3/account/whoami', expect.objectContaining({ headers: { authorization: 'Bearer secret' } }));
});

it('retains saved device credentials only for a reauthorized matching account', async () => {
  const dir = await root();
  const issued = { homeserver: 'https://matrix.test', userId: '@agent:test', deviceId: 'NEW', accessToken: 'new-token', roomId: '!r:test' };
  expect(await restoredCredentials(dir, issued)).toEqual(issued);
  await writeFile(path.join(dir, 'crypto.json'), JSON.stringify({ ...issued, deviceId: 'OLD', accessToken: 'old-token' }), { mode: 0o600 });
  expect(await restoredCredentials(dir, issued)).toEqual({ ...issued, deviceId: 'OLD', accessToken: 'old-token' });
  await expect(restoredCredentials(dir, { ...issued, userId: '@other:test' })).rejects.toThrow();
  await expect(restoredCredentials(dir, { ...issued, homeserver: 'https://other.test' })).rejects.toThrow();
});
