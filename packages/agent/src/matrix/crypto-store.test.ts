import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, readFile, readdir, symlink, writeFile, chmod } from 'node:fs/promises';
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

it('recognizes corrupt identity before attempting token validation', async () => {
  const dir = await root();
  await writeFile(path.join(dir, 'crypto.json'), '{broken', { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>();
  expect(await validateCryptoToken(dir, fetcher)).toBe('corrupt');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['crypto.json', 'crypto.sqlite'] as const)('recovers corrupt %s with a replacement device and new keys', async name => {
  const dir = await root();
  const first = await restart(dir);
  await writeFile(path.join(first.dir, name), 'not a valid crypto store', { mode: 0o600 });
  const result = await exec(process.execPath, ['--import', 'tsx', 'fixtures/crypto-store/restart.ts', dir,
    name === 'crypto.json' ? 'NEW' : 'DEVICE', 'keep', 'recover'], { cwd: path.resolve(import.meta.dirname, '../..') });
  const recovered = JSON.parse(result.stdout) as { keys: unknown; savedToken: string | null; restored: boolean };
  expect(recovered.restored).toBe(false);
  expect(recovered.keys).not.toEqual(first.keys);
  expect(recovered.savedToken).toBeNull();
}, 20_000);
it('wipes after an in-flight SDK save finishes, and tolerates a repeated wipe', async () => {
  const dir = await root();
  const result = await exec(process.execPath, ['--import', 'tsx', 'fixtures/crypto-store/restart.ts', dir, 'DEVICE', 'wipe-during-save'],
    { cwd: path.resolve(import.meta.dirname, '../..') });
  const saved = JSON.parse(result.stdout) as { dir: string };
  expect(await readdir(saved.dir)).not.toEqual(expect.arrayContaining(['crypto.json', 'crypto.sqlite', 'sync.sqlite']));
  for (const name of ['crypto.json', 'crypto.sqlite', 'sync.sqlite']) expect(await readdir(saved.dir)).not.toContain(name);
  expect(result.stderr).not.toContain('degrading');
}, 20_000);


it.skipIf(process.platform === 'win32').each(['symlink', 'readable', 'unreadable', 'corrupt'] as const)('unlinks %s crypto identity without reading or logging out its token', async kind => {
  vi.resetModules();
  const { wipeCryptoStore } = await import('./crypto-store');
  const { ensureStateDir } = await import('../state');
  const base = await root();
  const cryptoRoot = path.join(base, 'khala');
  const dir = path.join(cryptoRoot, 'channel');
  await ensureStateDir(dir);
  const target = path.join(base, 'identity.json');
  const identity = JSON.stringify({ homeserver: 'https://matrix.test', userId: '@agent:test', deviceId: 'D', accessToken: 'secret' });
  await writeFile(target, identity, { mode: 0o600 });
  const file = path.join(dir, 'crypto.json');
  if (kind === 'symlink') await symlink(target, file);
  else {
    await writeFile(file, kind === 'corrupt' ? '{broken' : identity, { mode: 0o600 });
    if (kind === 'readable') await chmod(file, 0o644);
    if (kind === 'unreadable') await chmod(file, 0o000);
  }
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  await wipeCryptoStore(dir, cryptoRoot, fetcher);
  expect(await readdir(dir)).not.toContain('crypto.json');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readFile(target, 'utf8')).toBe(identity);
});

it('refuses to wipe through a symlinked state directory', async () => {
  vi.resetModules();
  const { wipeCryptoStore } = await import('./crypto-store');
  const base = await root();
  const target = path.join(base, 'crypto.json');
  await writeFile(target, 'secret', { mode: 0o600 });
  const dir = path.join(base, 'alias');
  await symlink(base, dir);
  await expect(wipeCryptoStore(dir, base, vi.fn<typeof fetch>())).rejects.toThrow('unsafe_state_dir');
  expect(await readFile(target, 'utf8')).toBe('secret');
});

it('persists a bounded retry set across fresh processes and join metadata updates', async () => {
  const dir = await root();
  await exec(process.execPath, ['--import', 'tsx', 'fixtures/crypto-store/restart.ts', dir, 'DEVICE', 'retry-ids'], { cwd: path.resolve(import.meta.dirname, '../..') });
  const second = await restart(dir);
  const saved = JSON.parse(await readFile(path.join(second.dir, 'crypto.json'), 'utf8'));
  expect(saved.undecryptableEventIds.map((entry: { id: string }) => entry.id)).toEqual(Array.from({ length: 100 }, (_, i) => `$missing-${i + 5}`));
  expect(saved.joinedAt).toBe(100);
}, 20_000);

it('drops legacy and expired retry entries on load and persists pruning without resetting keys', async () => {
  const dir = await root(); const first = await restart(dir);
  const file = path.join(first.dir, 'crypto.json');
  const identity = JSON.parse(await readFile(file, 'utf8'));
  for (const entries of [['$legacy'], [{ id: '$expired', firstSeen: Date.now() - 8 * 24 * 60 * 60 * 1000 }]]) {
    await writeFile(file, JSON.stringify({ ...identity, undecryptableEventIds: entries }), { mode: 0o600 });
    const restored = await restart(dir);
    expect(restored.restored).toBe(true); expect(restored.keys).toEqual(first.keys);
    expect(JSON.parse(await readFile(file, 'utf8')).undecryptableEventIds).toEqual([]);
  }
}, 20_000);
it.each([{ id: '$bad', firstSeen: 'yesterday' }, { id: 1, firstSeen: 1 }, { id: '$bad', firstSeen: -1 }, { id: '$bad', firstSeen: 1e20 }])('rejects malformed retry metadata: %j', async entry => {
  const dir = await root();
  await writeFile(path.join(dir, 'crypto.json'), JSON.stringify({ homeserver: 'https://hs', userId: '@agent:hs', deviceId: 'D', undecryptableEventIds: [entry] }), { mode: 0o600 });
  expect(await validateCryptoToken(dir)).toBe('corrupt');
});
