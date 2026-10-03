import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  driverPath, freePort, guardedEnv, matrixModules, nonLoopbackAttempts, probePath,
  readEgressLog, runKhala, runNode, startHelper, stopHelper, type EgressRecord,
} from './fixtures/egress';

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
  const records = await readEgressLog(log);
  installed(records, [result.pid]);
  for (const host of ['192.0.2.1', 'khala.invalid', '0.0.0.0']) {
    for (const kind of ['tcp', 'udp', 'dns']) {
      expect(records.some(record => record.kind === kind && 'host' in record && record.host === host && !record.allowed), `${kind} ${host}`).toBe(true);
    }
  }
  expect(records.some(record => record.kind === 'tcp' && record.host === '127.0.0.1' && record.allowed)).toBe(true);
  expect(matrixModules(records)).toEqual([]);
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
  // Invalid local credentials must be rejected before any connection attempt.
  expect(nonLoopbackAttempts(records)).toEqual([]);
  expect(matrixModules(records)).toEqual([]);
}, 40_000);
it('runs helper, create, two real clients and stop without egress or Matrix', async () => {
  const log = join(dir, 'local.jsonl');
  const state = join(dir, 'state');
  await mkdir(state, { mode: 0o700 });
  const env = guardedEnv(log, { XDG_STATE_HOME: state, KHALA_LOCAL_PORT: String(await freePort()), KHALA_LOCAL_IDLE_MS: '600000', USER: 'egress' });
  const helper = await startHelper(env);
  const pids = [helper.child.pid!];
  let stopped = false;
  try {
    const created = await runKhala(['create', 'no-egress'], env);
    pids.push(created.pid);
    expect(created.code, created.stderr).toBe(0);
    const links = JSON.parse(created.stdout) as { selfLink: string; shareLink: string };
    const nonce = randomUUID();
    const driver = await runNode(['--import', 'tsx', driverPath], env, JSON.stringify({ ...links, nonce }));
    pids.push(driver.pid);
    expect(driver.code, driver.stderr).toBe(0);
    expect(JSON.parse(driver.stdout)).toMatchObject({ ok: true, codexSaw: `egress-ping-${nonce}`, claudeSaw: `egress-pong-${nonce}` });
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
    for (const pid of pids.slice(1)) expect(records.some(record => record.pid === pid && record.kind === 'tcp' && record.allowed)).toBe(true);
  } finally { if (!stopped) await stopHelper(helper, env); }
}, 60_000);
