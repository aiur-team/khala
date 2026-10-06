import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readWakeState, recordAttempt, settleAttempts } from './nonce';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-nonce-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const idle = { state: 'idle', updatedAt: 0 };
async function attempt(nonce = '12345678', at = 100) { await recordAttempt(root, { nonce, driver: 'queue', at, deadline: at + 30_000 }); }
it('resets failures on verified wake and never settles an attempt twice', async () => {
  await attempt();
  expect(await settleAttempts(root, { now: 30_100, activity: idle })).toMatchObject([{ status: 'failure' }]);
  await attempt('abcdef12', 40_000);
  expect(await settleAttempts(root, { now: 40_001, activity: idle, promptText: 'notice (k-abcdef12)' })).toMatchObject([{ status: 'success' }]);
  expect(await readWakeState(root)).toEqual({ queue: { failures: 0 } });
  expect(await settleAttempts(root, { now: 90_000, activity: idle })).toEqual([]);
});
it('disables after two idle timeouts only in this session', async () => {
  await attempt(); await settleAttempts(root, { now: 30_100, activity: idle });
  await attempt('abcdef12', 40_000); await settleAttempts(root, { now: 70_000, activity: idle });
  expect((await readWakeState(root)).queue).toMatchObject({ failures: 2, disabled: true, reason: 'nonce_timeout' });
  expect(JSON.parse(await fs.readFile(path.join(root, 'wake-state.json'), 'utf8')).queue.disabled).toBe(true);
  expect(await readWakeState(path.join(root, 'other-session'))).toEqual({});
});
it.each([
  { now: 200, activity: { state: 'busy', updatedAt: 200 } },
  { now: 30_100, activity: { state: 'idle', updatedAt: 200 } },
  { now: 200, activity: idle, promptText: 'a user prompt' },
])('voids user activity without counting a failure (%j)', async input => {
  await attempt();
  expect(await settleAttempts(root, input)).toMatchObject([{ status: 'void' }]);
  expect(await readWakeState(root)).toEqual({});
});
it('serializes simultaneous hook and poll settlement to count once', async () => {
  await attempt();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => settleAttempts(root, { now: 30_100, activity: idle })));
  expect(outcomes.flat()).toHaveLength(1);
  expect((await readWakeState(root)).queue?.failures).toBe(1);
});

it('voids even a matching nonce after prior activity', async () => {
  await attempt();
  expect(await settleAttempts(root, { now: 300, activity: { state: 'idle', updatedAt: 200 }, promptText: '(k-12345678)' })).toMatchObject([{ status: 'void' }]);
  expect(await readWakeState(root)).toEqual({});
});
it('counts a late prompt as failure if activity stayed idle', async () => {
  await attempt();
  expect(await settleAttempts(root, { now: 31_000, activity: idle, promptText: '(k-12345678)' })).toMatchObject([{ status: 'failure' }]);
});

it('reclaims an abandoned owner without losing concurrent updates', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.on('exit', () => resolve()); child.on('error', reject); });
  const lock = path.join(root, 'wake.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, `owner-${pid}-1234567890abcdef`), '');
  await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(i.toString(16).padStart(8, '0'))));
  const settlements = await settleAttempts(root, { now: 30_100, activity: idle });
  expect(settlements).toHaveLength(8);
});

it('waits for a live owner rather than reclaiming its lock', async () => {
  const lock = path.join(root, 'wake.lock');
  await fs.mkdir(lock);
  const owner = path.join(lock, `owner-${process.pid}-1234567890abcdef`);
  await fs.writeFile(owner, '');
  let finished = false;
  const pending = attempt().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(finished).toBe(false);
  expect(await fs.readFile(owner, 'utf8')).toBe('');
  await fs.unlink(owner);
  await pending;
  expect(finished).toBe(true);
});

it('does not create wake files or acquire a lock when no journal exists', async () => {
  await fs.mkdir(path.join(root, 'wake.lock'));
  await fs.writeFile(path.join(root, 'wake.lock', `owner-${process.pid}-1234567890abcdef`), '');
  expect(await settleAttempts(root, { now: 100, activity: idle, promptText: 'hello' })).toEqual([]);
  expect((await fs.readdir(root)).sort()).toEqual(['wake.lock']);
});

it('cancels only the unsent attempt and leaves another pending nonce intact', async () => {
  const { cancelAttempt } = await import('./nonce');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-cancel-nonce-'));
  try {
    await recordAttempt(dir, { nonce: '00000001', driver: 'terminal', at: 1, deadline: 10 });
    await recordAttempt(dir, { nonce: '00000002', driver: 'queue', at: 1, deadline: 10 });
    await cancelAttempt(dir, '00000001');
    expect(await settleAttempts(dir, { now: 10, activity: { state: 'idle', updatedAt: 0 } })).toEqual([
      { nonce: '00000002', driver: 'queue', status: 'failure' },
    ]);
    expect(await readWakeState(dir)).toEqual({ queue: { failures: 1 } });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
