import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chooseWakeDriver, createWakeLadder, type WakeLadder } from './ladder';
import type { WakeDriver, WakeDriverContext } from './driver';
import { openSessionDir, saveSession, writeJsonAtomic, stateRoot } from '../state';
import { appendEntries } from '../inbox';
import { writeActivity } from '../activity';
import { recordAttempt, settleAttempts, readWakeState } from './shared';

let root: string;
let ctx: WakeDriverContext;
let loop: WakeLadder | undefined;
const at = Date.parse('2026-10-05T00:00:00Z');
const driver = (extra: Partial<WakeDriver> = {}): WakeDriver => ({ id: 'native', rung: 1, optIn: false, minIdleMs: 0, available: () => true, wake: vi.fn(), ...extra });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-ladder-'));
  const env = { XDG_STATE_HOME: root };
  ctx = { files: await openSessionDir('codex', 'ladder', env), sessionId: 'ladder', harness: 'codex', env, signal: new AbortController().signal, now: at };
});
afterEach(async () => { await loop?.stop(); loop = undefined; await fs.rm(root, { recursive: true, force: true }); });
it('orders available rungs, wakes native immediately and waits thirty seconds for terminal', async () => {
  const native = driver();
  const terminal = driver({ id: 'terminal', rung: 4, minIdleMs: 30_000 });
  const idle = { state: 'idle' as const, updatedAt: new Date(at).toISOString() };
  expect(await chooseWakeDriver([terminal, native], ctx, idle)).toBe(native);
  expect(await chooseWakeDriver([terminal], ctx, idle)).toBeUndefined();
  expect(await chooseWakeDriver([driver({ minIdleMs: 30_000 }), driver({ id: 'later', rung: 4 })], ctx, idle)).toBeUndefined();
  expect(await chooseWakeDriver([terminal], { ...ctx, now: at + 30_000 }, idle)).toBe(terminal);
  expect(await chooseWakeDriver([native], ctx, { ...idle, state: 'busy' })).toBeUndefined();
  expect(await chooseWakeDriver([terminal], { ...ctx, env: { ...ctx.env, KHALA_WAKE_TEST_IDLE_MS: '0' } }, idle)).toBe(terminal);
});
it('requires machine consent and honors machine off even for native drivers', async () => {
  const opted = driver({ optIn: true });
  const idle = { state: 'idle' as const, updatedAt: new Date(at).toISOString() };
  expect(await chooseWakeDriver([opted], ctx, idle)).toBeUndefined();
  await writeJsonAtomic(path.join(stateRoot(ctx.env), 'wake-settings.json'), { consent: { 'codex/native': { at: 'now' } }, off: {} });
  expect(await chooseWakeDriver([opted], ctx, idle)).toBe(opted);
  await writeJsonAtomic(path.join(stateRoot(ctx.env), 'wake-settings.json'), { consent: {}, off: { 'codex/native': { at: 'now' } } });
  expect(await chooseWakeDriver([driver()], ctx, idle)).toBeUndefined();
});
it('disables a driver after two idle timeouts only in its session and falls through', async () => {
  const native = driver();
  const fallback = driver({ id: 'fallback', rung: 4 });
  for (const [index, nonce] of ['12345678', '87654321'].entries()) {
    await recordAttempt(ctx.files.dir, { nonce, driver: native.id, at: at + index * 60_000, deadline: at + index * 60_000 + 30_000 });
    await settleAttempts(ctx.files.dir, { now: at + index * 60_000 + 30_000, activity: { state: 'idle', updatedAt: at - 1 } });
  }
  expect((await readWakeState(ctx.files.dir)).native?.disabled).toBe(true);
  const idle = { state: 'idle' as const, updatedAt: new Date(at - 1).toISOString() };
  expect(await chooseWakeDriver([native, fallback], ctx, idle)).toBe(fallback);
  const files = await openSessionDir('codex', 'other', ctx.env);
  expect(await chooseWakeDriver([native], { ...ctx, files, sessionId: 'other' }, idle)).toBe(native);
});
it('suppresses own messages and async channels, then sends a nonce for unread peers', async () => {
  await saveSession(ctx.files, { homeserver: 'https://example.test', roomId: 'room', userId: 'self', accessToken: 'token', deviceId: 'd' });
  await writeActivity(ctx.files, 'idle', () => new Date(at - 1));
  await appendEntries(ctx.files, [{ eventId: 'own', roomId: 'room', ts: 'now', sender: 'self', senderLabel: 'self', senderKind: 'human', body: 'hello', kind: 'message' }]);
  const wake = vi.fn();
  loop = createWakeLadder({ files: ctx.files, harness: 'codex', sessionId: 'ladder', env: ctx.env, drivers: [driver({ wake })], pollMs: 100_000, now: () => at });
  loop.notify();
  await new Promise(resolve => setTimeout(resolve, 70));
  expect(wake).not.toHaveBeenCalled();
  await appendEntries(ctx.files, [{ eventId: 'peer', roomId: 'room', ts: 'now', sender: 'peer', senderLabel: 'peer', senderKind: 'human', body: 'hello', kind: 'message' }]);
  await writeJsonAtomic(ctx.files.mode, { mode: 'async' });
  loop.notify(); await new Promise(resolve => setTimeout(resolve, 70));
  expect(wake).not.toHaveBeenCalled();
  await writeJsonAtomic(ctx.files.mode, { mode: 'sync' }); loop.notify();
  await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
  expect(wake.mock.calls[0]?.[1]).toMatch(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/);
});

it('gives fallback its own budget after two timeout failures in the running ladder', async () => {
  let time = at;
  const wake = vi.fn();
  const fallbackWake = vi.fn();
  await writeActivity(ctx.files, 'idle', () => new Date(at - 1));
  await appendEntries(ctx.files, [{ eventId: 'peer', roomId: 'room', ts: 'now', sender: 'peer', senderLabel: 'peer', senderKind: 'human', body: 'hello', kind: 'message' }]);
  loop = createWakeLadder({ files: ctx.files, harness: 'codex', sessionId: 'ladder', env: ctx.env,
    drivers: [driver({ wake }), driver({ id: 'fallback', rung: 4, wake: fallbackWake })], pollMs: 100_000, now: () => time });
  loop.notify(); await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
  time += 60_000; loop.notify(); await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
  time += 30_000; loop.notify(); await vi.waitFor(() => expect(fallbackWake).toHaveBeenCalledOnce());
  expect((await readWakeState(ctx.files.dir)).native?.disabled).toBe(true);
});

it.each(['busy', 'stop', 'off'])('does not wake when %s changes while availability is pending', async change => {
  let resolve!: (available: boolean) => void;
  const available = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  const wake = vi.fn();
  await writeActivity(ctx.files, 'idle', () => new Date(at - 1));
  await appendEntries(ctx.files, [{ eventId: 'peer', roomId: 'room', ts: 'now', sender: 'peer', senderLabel: 'peer', senderKind: 'human', body: 'hello', kind: 'message' }]);
  loop = createWakeLadder({ files: ctx.files, harness: 'codex', sessionId: 'ladder', env: ctx.env,
    drivers: [driver({ available, wake })], pollMs: 100_000, now: () => at });
  loop.notify(); await vi.waitFor(() => expect(available).toHaveBeenCalledOnce());
  let stopping: Promise<void> | undefined;
  if (change === 'busy') await writeActivity(ctx.files, 'busy', () => new Date(at));
  if (change === 'stop') stopping = loop.stop();
  if (change === 'off') await writeJsonAtomic(path.join(stateRoot(ctx.env), 'wake-settings.json'), { consent: {}, off: { 'codex/native': { at: 'now' } } });
  resolve(true);
  if (stopping) await stopping;
  else await new Promise(done => setTimeout(done, 70));
  expect(wake).not.toHaveBeenCalled();
});

it('starts nonce deadlines after a slow availability probe completes', async () => {
  let time = at;
  const wake = vi.fn();
  await writeActivity(ctx.files, 'idle', () => new Date(at - 1));
  await appendEntries(ctx.files, [{ eventId: 'peer', roomId: 'room', ts: 'now', sender: 'peer', senderLabel: 'peer', senderKind: 'human', body: 'hello', kind: 'message' }]);
  loop = createWakeLadder({ files: ctx.files, harness: 'codex', sessionId: 'ladder', env: ctx.env,
    drivers: [driver({ available: () => { time += 40_000; return true; }, wake })], pollMs: 100_000, now: () => time });
  loop.notify(); await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
  const journal = JSON.parse(await fs.readFile(path.join(ctx.files.dir, 'wake-journal.json'), 'utf8'));
  expect(journal.attempts[0]).toMatchObject({ at: at + 40_000, deadline: at + 70_000 });
  expect(wake.mock.calls[0]?.[0].now).toBe(at + 40_000);
});
