import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  driverPath, freePort, guardedEnv, matrixModules, nonLoopbackAttempts, probePath,
  eventually, readEgressLog, runKhala, runNode, startHelper, stopHelper, type EgressRecord,
} from './fixtures/egress';
import { readHelperFile } from './lifecycle';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'khala-egress-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function installed(records: EgressRecord[], pids: number[]): void {
  expect(records.filter(record => record.kind === 'guard' && record.event === 'no_module_hooks')).toEqual([]);
  for (const pid of pids) {
    const processRecords = records.filter(record => record.pid === pid);
    expect(processRecords[0]).toMatchObject({ v: 1, kind: 'guard', event: 'installed', pid });
  }
}
it('positively proves TCP, TLS, UDP, DNS blocking and loopback access', async () => {
  const log = join(dir, 'probe.jsonl');
  const result = await runNode([probePath], guardedEnv(log));
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  expect(result.stderr).toContain('khala-egress-guard: blocked tcp 192.0.2.1:');
  const records = await readEgressLog(log);
  installed(records, [result.pid]);
  for (const host of ['192.0.2.1', 'khala.invalid', '0.0.0.0']) {
    for (const kind of ['tcp', 'udp', 'dns']) {
      expect(records.some(record => record.kind === kind && 'host' in record && record.host === host && !record.allowed), `${kind} ${host}`).toBe(true);
    }
  }
  expect(records.some(record => record.kind === 'tcp' && record.host === '127.0.0.1' && record.allowed)).toBe(true);
  expect(records.some(record => record.kind === 'worker' && !record.allowed)).toBe(true);
  expect(records.some(record => record.kind === 'exec' && !record.allowed && !record.guarded)).toBe(true);
  expect(records.some(record => record.kind === 'exec' && record.allowed && record.guarded)).toBe(true);
  expect(matrixModules(records)).toEqual([]);
}, 40_000);
it('does not install or log the guard in an unguarded loopback-only probe', async () => {
  const log = join(dir, 'unguarded.jsonl');
  const result = await runNode([probePath, '--loopback-only'], {
    ...process.env, NODE_OPTIONS: '', KHALA_EGRESS_LOG: log,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  await expect(access(log)).rejects.toMatchObject({ code: 'ENOENT' });
}, 40_000);
it('records Matrix resolution only when imported', async () => {
  for (const matrix of [false, true]) {
    const log = join(dir, `${matrix}.jsonl`);
    const result = await runNode([probePath, ...(matrix ? ['matrix'] : [])], guardedEnv(log));
    expect(result.code, result.stderr).toBe(0);
    const records = await readEgressLog(log);
    installed(records, [result.pid]);
    expect(matrixModules(records)).toHaveLength(matrix ? 1 : 0);
  }
}, 60_000);
it('rejects non-loopback local credentials under the guard', async () => {
  const log = join(dir, 'hostile.jsonl');
  const accessToken = `private-egress-token-${randomUUID()}`;
  const result = await runNode(['--import', 'tsx', driverPath], guardedEnv(log), JSON.stringify({ hostile: true, accessToken }));
  expect(result.code, result.stderr).toBe(0);
  const records = await readEgressLog(log);
  installed(records, [result.pid]);
  expect(result.stdout).not.toContain(accessToken);
  expect(result.stderr).not.toContain(accessToken);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  // Invalid credentials must not even attempt an allowed loopback connection.
  expect(records.filter(record => ['tcp', 'udp', 'dns'].includes(record.kind))).toEqual([]);
  expect(nonLoopbackAttempts(records)).toEqual([]);
  expect(matrixModules(records)).toEqual([]);
}, 40_000);
it('runs helper, create, two real clients and stop without egress or Matrix', async () => {
  const log = join(dir, 'local.jsonl');
  const state = join(dir, 'state');
  await mkdir(state, { mode: 0o700 });
  const webDir = join(dir, 'web');
  await mkdir(join(webDir, 'assets'), { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><script src="/assets/egress.js"></script>');
  await writeFile(join(webDir, 'assets', 'egress.js'), '/* no-egress static fixture */');
  const env = guardedEnv(log, { KHALA_LOCAL_WEB_DIR: webDir, XDG_STATE_HOME: state, KHALA_LOCAL_PORT: String(await freePort()), KHALA_LOCAL_IDLE_MS: '600000', USER: 'egress' });
  const helper = await startHelper(env);
  const pids = [helper.child.pid!];
  let stopped = false;
  try {
    const created = await runKhala(['create', 'no-egress'], env);
    pids.push(created.pid);
    expect(created.code, created.stderr).toBe(0);
    const links = JSON.parse(created.stdout) as { roomId: string; selfLink: string; shareLink: string };
    const nonce = randomUUID();
    const driver = await runNode(['--import', 'tsx', driverPath], env, JSON.stringify({ ...links, nonce }));
    pids.push(driver.pid);
    expect(driver.code, driver.stderr).toBe(0);
    expect(JSON.parse(driver.stdout)).toMatchObject({ ok: true, codexSaw: `egress-ping-${nonce}`, claudeSaw: `egress-pong-${nonce}`, liveReceipts: true, mode: 'steer', removed: true, web: true });
    const stop = await stopHelper(helper, env);
    stopped = true;
    pids.push(stop.pid);
    expect(stop.code, stop.stderr).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ stopped: true });
    const records = await readEgressLog(log);
    installed(records, pids);
    const allPids = [...new Set(records.map(record => record.pid))];
    installed(records, allPids);
    expect(nonLoopbackAttempts(records)).toEqual([]);
    expect(matrixModules(records)).toEqual([]);
    for (const record of records) if (record.kind === 'exec') expect(record.guarded).toBe(true);
    for (const pid of pids.slice(1)) expect(records.some(record => record.pid === pid && record.kind === 'tcp' && record.allowed)).toBe(true);
  } finally { if (!stopped) await stopHelper(helper, env); }
}, 60_000);
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
it('auto-starts the guarded helper from the CLI without egress or denied exec', async () => {
  const log = join(dir, 'auto-start.jsonl');
  const state = join(dir, 'state');
  await mkdir(state, { mode: 0o700 });
  const env = guardedEnv(log, { XDG_STATE_HOME: state, KHALA_LOCAL_PORT: String(await freePort()), KHALA_LOCAL_IDLE_MS: '600000', USER: 'egress' });
  let helperPid: number | undefined;
  try {
    const created = await runKhala(['create', 'auto-start'], env);
    expect(created.code, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ roomId: expect.any(String) });
    helperPid = (await readHelperFile(env))?.pid;
    expect(helperPid).toBeTypeOf('number');
    expect(helperPid).not.toBe(created.pid);
    expect(alive(helperPid!)).toBe(true);
    const stop = await runKhala(['stop'], env);
    expect(stop.code, stop.stderr).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ stopped: true });
    await eventually(async () => !alive(helperPid!));
    const records = await readEgressLog(log);
    installed(records, [created.pid, helperPid!, stop.pid]);
    expect(nonLoopbackAttempts(records)).toEqual([]);
    expect(records.filter(record => record.kind === 'exec' && !record.allowed)).toEqual([]);
    expect(matrixModules(records)).toEqual([]);
  } finally { if (helperPid !== undefined && alive(helperPid)) process.kill(helperPid, 'SIGKILL'); }
}, 60_000);
