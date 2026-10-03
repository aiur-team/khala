import { existsSync, fstatSync, openSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelperFile } from '@khala/contracts/m1/local';
import { ensureStateDir, StateError, writeJsonAtomic } from '../state';
import { ensureHelper, helperBinPath, helperChildEnv, helperPaths, readHelperFile, HELPER_ENV_ALLOWLIST, type EnsureHelperDeps } from './lifecycle';

let tmp: string;
let env: NodeJS.ProcessEnv;
const token = 'A'.repeat(43);
function file(pid = 4242, adminToken = token): HelperFile {
  return { v: 1, pid, port: 47830, origin: 'http://127.0.0.1:47830', adminToken, version: '0.0.0', startedAt: '2026-10-02T12:00:00.000Z' };
}
async function write(value: unknown = file()) {
  const paths = helperPaths(env);
  await ensureStateDir(path.join(paths.root, 'channels'));
  await writeJsonAtomic(paths.helperFile, value);
}
function fake() {
  let time = 0;
  const child = { unref: vi.fn(), on: vi.fn() };
  const spawn = vi.fn<NonNullable<EnsureHelperDeps['spawn']>>(() => child);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true, pid: 4242 })));
  const sleep = vi.fn(async (ms: number) => { time += ms; });
  const openLog = vi.fn(async (log: string) => openSync(log, 'a', 0o600));
  const deps: EnsureHelperDeps = { spawn, fetch, sleep, now: () => time, openLog };
  return { child, spawn, fetch, sleep, openLog, deps, time: () => time };
}
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-lifecycle-')); env = { XDG_STATE_HOME: tmp }; });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('helper metadata', () => {
  it('resolves paths and the sibling executable', () => {
    expect(helperPaths({ XDG_STATE_HOME: '/s' })).toEqual({ root: '/s/khala/local', helperFile: '/s/khala/local/helper.json', logFile: '/s/khala/local/helper.log', port: 47830, origin: 'http://127.0.0.1:47830' });
    expect(helperBinPath()).toMatch(/packages\/agent\/bin\/khala\.mjs$/);
    expect(existsSync(helperBinPath())).toBe(true);
  });
  it.each(['1', '5000', '65535'])('accepts port %s', port => { expect(helperPaths({ KHALA_LOCAL_PORT: port }).port).toBe(Number(port)); });
  it.each(['0', '70000', '12a', '-1', '1.5', ' 5000', '999999'])('defaults invalid port %s', port => { expect(helperPaths({ KHALA_LOCAL_PORT: port }).port).toBe(47830); });
  it('reads only valid helper files', async () => {
    expect(await readHelperFile(env)).toBeNull();
    await write();
    expect(await readHelperFile(env)).toEqual(file());
    for (const change of [{ v: 2 }, { origin: 'http://127.0.0.1:5000' }, { adminToken: 'short' }, { adminToken: '!'.repeat(43) }, { pid: -1 }, { pid: Number.MAX_SAFE_INTEGER + 1 }, { port: 65536 }, { port: 0 }]) {
      await write({ ...file(), ...change });
      expect(await readHelperFile(env)).toBeNull();
    }
    await fs.writeFile(helperPaths(env).helperFile, '{');
    expect(await readHelperFile(env)).toBeNull();
  });
  it('preserves file I/O errors', async () => {
    await fs.mkdir(helperPaths(env).helperFile, { recursive: true });
    await expect(readHelperFile(env)).rejects.toEqual(new StateError('storage_failed'));
  });
  it('inherits exactly the approved environment, including the guard preload', () => {
    const source = Object.fromEntries(HELPER_ENV_ALLOWLIST.map(key => [key, key]));
    expect(HELPER_ENV_ALLOWLIST).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_STATE_HOME', 'NODE_OPTIONS', 'KHALA_LOCAL_PORT', 'KHALA_LOCAL_IDLE_MS', 'KHALA_LOCAL_WEB_DIR']);
    expect(helperChildEnv({ ...source, OPENAI_API_KEY: 'secret', KHALA_ADMIN_TOKEN: token, CODEX_HOME: '/secret' })).toEqual(source);
    expect(helperChildEnv({ HOME: '/home/me', PATH: undefined })).toEqual({ HOME: '/home/me' });
  });
});

describe('ensureHelper', () => {
  it('reuses a healthy helper with a bounded health request', async () => {
    await write();
    const f = fake();
    await expect(ensureHelper(env, f.deps)).resolves.toEqual({ origin: file().origin, adminToken: token });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledWith(`${file().origin}/healthz`, { signal: expect.any(AbortSignal) });
  });
  it('starts a detached child and waits for fresh matching metadata', async () => {
    env = { ...env, USER: 'me', NODE_OPTIONS: '--import /x/guard.mjs', OPENAI_API_KEY: 'secret', KHALA_SESSION_TOKEN: token, CLAUDE_CODE_SESSION_ID: 'private' };
    await write(file(1));
    const f = fake();
    f.fetch.mockImplementation(async () => { if (f.sleep.mock.calls.length < 3) throw new Error('ECONNREFUSED'); return new Response(JSON.stringify({ ok: true, pid: 4242 })); });
    const advance = f.sleep.getMockImplementation()!;
    f.sleep.mockImplementation(async ms => { await advance(ms); if (f.sleep.mock.calls.length === 3) await write(file(4242, 'B'.repeat(43))); });
    await expect(ensureHelper(env, f.deps)).resolves.toEqual({ origin: file().origin, adminToken: 'B'.repeat(43) });
    const fd = await f.openLog.mock.results[0]!.value;
    expect(() => fstatSync(fd)).toThrow();
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, [helperBinPath(), 'local', 'serve'], { detached: true, stdio: ['ignore', fd, fd], env: helperChildEnv(env), cwd: helperPaths(env).root, shell: false });
    expect(JSON.stringify(f.spawn.mock.calls)).not.toContain(token);
    expect(f.child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(f.child.unref).toHaveBeenCalledOnce();
    expect(f.sleep.mock.calls).toEqual([[100], [100], [100]]);
  });
  it.each(['wrong pid', 'non-200', 'bad JSON', 'ok false', 'throw'])('rejects unhealthy health responses: %s', async kind => {
    await write();
    const f = fake();
    f.fetch.mockImplementation(async () => {
      if (kind === 'throw') throw new Error('timeout');
      if (kind === 'bad JSON') return new Response('{');
      return new Response(JSON.stringify({ ok: kind !== 'ok false', pid: kind === 'wrong pid' ? 2 : 4242 }), { status: kind === 'non-200' ? 503 : 200 });
    });
    await expect(ensureHelper(env, f.deps)).rejects.toMatchObject({ code: 'internal_error', message: 'helper_unavailable' });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.time()).toBe(5000);
  });
  it('requires helper.json even when healthz answers', async () => {
    const f = fake();
    await expect(ensureHelper(env, f.deps)).rejects.toMatchObject({ message: 'helper_unavailable' });
    expect(f.time()).toBe(5000);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('shares an in-flight attempt then rechecks on later calls', async () => {
    const f = fake();
    f.sleep.mockImplementation(async () => { await write(); });
    const results = await Promise.all([ensureHelper(env, f.deps), ensureHelper(env, f.deps)]);
    expect(results[0]).toEqual(results[1]);
    expect(f.spawn).toHaveBeenCalledOnce();
    await ensureHelper(env, f.deps);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('clears failed attempts so a later call retries', async () => {
    const f = fake();
    f.spawn.mockImplementation(() => { throw new Error(token); });
    for (let i = 0; i < 2; i++) await expect(ensureHelper(env, f.deps)).rejects.toMatchObject({ message: 'helper_unavailable' });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    for (const result of f.openLog.mock.results) { const fd = await result.value; expect(() => fstatSync(fd)).toThrow(); }
  });
  it('fails promptly on a child error', async () => {
    const f = fake();
    f.child.on.mockImplementation((_event, listener) => { listener(new Error(token)); });
    await expect(ensureHelper(env, f.deps)).rejects.toMatchObject({ message: 'helper_unavailable' });
    expect(f.sleep).not.toHaveBeenCalled();
  });
  it('maps log-open failures to helper_unavailable', async () => {
    const f = fake();
    f.openLog.mockRejectedValue(new Error(token));
    await expect(ensureHelper(env, f.deps)).rejects.toMatchObject({ message: 'helper_unavailable' });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('checks only Khala-owned directories and refuses unsafe state', async () => {
    await fs.chmod(tmp, 0o755);
    const f = fake();
    f.sleep.mockImplementation(async () => { await write(); });
    await ensureHelper(env, f.deps);
    await fs.chmod(helperPaths(env).root, 0o755);
    await fs.unlink(helperPaths(env).helperFile);
    await expect(ensureHelper(env, f.deps)).rejects.toEqual(new StateError('unsafe_state_dir'));
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it('appends to a private log and closes the parent descriptor', async () => {
    await write();
    const log = helperPaths(env).logFile;
    await fs.writeFile(log, 'older log\n', { mode: 0o644 });
    const f = fake();
    f.fetch.mockRejectedValueOnce(new Error('stale'));
    const defaultLogDeps = { ...f.deps };
    delete defaultLogDeps.openLog;
    await ensureHelper(env, defaultLogDeps);
    const options = f.spawn.mock.calls[0]![2];
    const fd = (options.stdio as ['ignore', number, number])[1];
    expect((await fs.stat(log)).mode & 0o777).toBe(0o600);
    for (const dir of [helperPaths(env).root, path.join(helperPaths(env).root, 'channels')]) expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(log, 'utf8')).toBe('older log\n');
    expect(() => fstatSync(fd)).toThrow();
  });
});
