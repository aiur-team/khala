import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultHumanColor } from '@khala/contracts/m1/colors';
import { isLocalRoomId, localRoomKey, type HelperFile } from '@khala/contracts/m1/local';
import { helperPaths, readHelperFile } from './lifecycle';
import { runHelper } from './serve';
import { runLocalCommand } from './cli';
import { ownerRoutes } from './routes/owner';
import { profileRoutes } from './routes/profile';
import { openLocalStore } from './store';
vi.mock('./routes/owner', { spy: true });
vi.mock('./routes/profile', { spy: true });
vi.mock('./store', { spy: true });
let root: string; let env: NodeJS.ProcessEnv; let webDir: string;
let active: { abort: AbortController; exit: Promise<number> }[];
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'ki137-serve-')); env = { XDG_STATE_HOME: root, HOME: root, USER: 'kevin' };
  webDir = join(root, 'web'); await mkdir(webDir); await writeFile(join(webDir, 'index.html'), 'index'); active = [];
});
afterEach(async () => {
  vi.useRealTimers();
  for (const helper of active) { helper.abort.abort(); await helper.exit; }
  await rm(root, { recursive: true, force: true });
});
async function start(idleMs = 60_000) {
  const abort = new AbortController(); const exit = runHelper({ env, port: 0, webDir, idleMs, signal: abort.signal });
  active.push({ abort, exit });
  let file: HelperFile | null = null;
  for (let attempt = 0; attempt < 150 && !file; attempt++) { file = await readHelperFile(env); if (!file) await sleep(20); }
  expect(file).not.toBeNull();
  return { file: file!, abort, exit };
}
async function command(argv: string[]) {
  const stdout = vi.fn(); const stderr = vi.fn();
  const code = await runLocalCommand(argv, { env, stdout, stderr, ensureHelper: async () => (await readHelperFile(env))! });
  expect(code).toBe(0); expect(stdout).toHaveBeenCalledTimes(1);
  return JSON.parse(stdout.mock.calls[0]![0]);
}
describe('real helper composition', () => {
  it('shares one serial queue between owner and profile routes', async () => {
    await start();
    expect(ownerRoutes).toHaveBeenCalledTimes(1);
    expect(profileRoutes).toHaveBeenCalledTimes(1);
    const queue = vi.mocked(ownerRoutes).mock.calls[0]?.[0]?.queue;
    expect(queue).toBeTypeOf('function');
    expect(vi.mocked(profileRoutes).mock.calls[0]?.[0]?.queue).toBe(queue);
  });
  it('bootstraps owner, wires every route, and drains storage on shutdown', async () => {
    const helper = await start();
    const store = await vi.mocked(openLocalStore).mock.results[0]!.value;
    const close = vi.spyOn(store, 'close');
    expect(close).not.toHaveBeenCalled();
    expect(helper.file.pid).toBe(process.pid);
    expect(helper.file.origin).toBe(`http://127.0.0.1:${helper.file.port}`);
    expect((await stat(helperPaths(env).helperFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(helperPaths(env).root, 'owner.json'), 'utf8'))).toMatchObject({ username: 'kevin', color: defaultHumanColor('@khala_owner:local') });
    const created = await command(['create', 'refactor']);
    expect(isLocalRoomId(created.roomId)).toBe(true);
    for (const key of ['selfLink', 'shareLink']) expect(created[key]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join\/[A-Za-z0-9_-]{43}$/u);
    expect(created.selfLink).not.toBe(created.shareLink);
    expect((await command(['list'])).channels).toHaveLength(1);
    expect((await command(['link', 'refactor'])).shareLink).not.toBe(created.shareLink);
    expect(await command(['status'])).toMatchObject({ running: true, channels: 1 });
    const opened = await fetch(created.openUrl, { redirect: 'manual' });
    expect(opened.status).toBe(302);
    const cookie = opened.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    const profile = await fetch(helper.file.origin + '/api/local/profile', { headers: { cookie: cookie.split(';')[0]! } });
    expect(await profile.json()).toMatchObject({ username: 'kevin' });
    expect((await fetch(created.openUrl, { redirect: 'manual' })).status).not.toBe(302);
    const initialLog = await readFile(join(helperPaths(env).root, 'channels', localRoomKey(created.roomId), 'log.jsonl'), 'utf8');
    expect(initialLog.trim().split('\n')).toHaveLength(2);
    const joined = await fetch(helper.file.origin + '/api/agent/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: created.selfLink, harness: 'claude', label: 'Claude' }) });
    expect(joined.status).toBe(201);
    const pending = await joined.json();
    const poll = await fetch(helper.file.origin + `/api/agent/join/poll?joinId=${pending.joinId}`, { headers: { authorization: `Bearer ${pending.pollSecret}` } });
    expect(poll.status).toBe(200);
    const credentials = (await poll.json()).credentials;
    const forbidden = await fetch(helper.file.origin + '/api/local/channels', { headers: { authorization: `Bearer ${credentials.accessToken}` } });
    expect(forbidden.status).toBe(403);
    expect(await command(['stop'])).toEqual({ stopped: true }); expect(await helper.exit).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readHelperFile(env)).toBeNull();
    const log = await readFile(join(helperPaths(env).root, 'channels', localRoomKey(created.roomId), 'log.jsonl'), 'utf8');
    const events = log.trim().split('\n').map(line => JSON.parse(line));
    expect(events.slice(0, 2)).toMatchObject([{ seq: 1, type: 'm.room.create', content: { name: 'refactor' } }, { seq: 2, type: 'm.room.member', content: { displayname: 'kevin' } }]);
    const restarted = await start();
    expect(restarted.file.adminToken).not.toBe(helper.file.adminToken);
    expect((await command(['list'])).channels[0].roomId).toBe(created.roomId);
    expect((await fetch(restarted.file.origin + '/api/local/profile', { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(401);
    expect(await command(['delete', 'refactor'])).toEqual({ deleted: created.roomId });
    expect((await command(['list'])).channels).toHaveLength(0);
  });
  it('a losing helper preserves the existing file byte for byte', async () => {
    const helper = await start(); const before = await readFile(helperPaths(env).helperFile, 'utf8');
    expect(await runHelper({ env, port: helper.file.port, webDir })).toBe(0);
    expect(await readFile(helperPaths(env).helperFile, 'utf8')).toBe(before);
    expect((await fetch(helper.file.origin + '/healthz')).status).toBe(200);
  });
  it('rejects a foreign listener without writing owner or helper files', async () => {
    const stranger = createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>(resolve => stranger.listen(0, '127.0.0.1', resolve));
    try {
      const port = (stranger.address() as { port: number }).port; const stderr = vi.fn();
      expect(await runHelper({ env, port, webDir, stderr })).toBe(1);
      expect(stderr).toHaveBeenCalledExactlyOnceWith('{"error":"port_in_use"}\n');
      await expect(stat(join(helperPaths(env).root, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readHelperFile(env)).toBeNull();
    } finally { await new Promise<void>(resolve => stranger.close(() => resolve())); }
  });
  it('stops on abort and removes its discovery file', async () => {
    const helper = await start(); helper.abort.abort(); expect(await helper.exit).toBe(0); expect(await readHelperFile(env)).toBeNull();
  });
  it('handles process signals and an already aborted stop request', async () => {
    const helper = await start();
    const store = await vi.mocked(openLocalStore).mock.results[0]!.value;
    const close = vi.spyOn(store, 'close');
    expect(close).not.toHaveBeenCalled();
    process.emit('SIGTERM');
    expect(await helper.exit).toBe(0); expect(await readHelperFile(env)).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    const abort = new AbortController(); abort.abort();
    expect(await runHelper({ env, port: 0, webDir, signal: abort.signal })).toBe(0);
    expect(await readHelperFile(env)).toBeNull();
  });
  it('exits on idle using the HTTP core timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const helper = await start(100);
    const store = await vi.mocked(openLocalStore).mock.results[0]!.value;
    const close = vi.spyOn(store, 'close');
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await helper.exit).toBe(0); expect(await readHelperFile(env)).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
