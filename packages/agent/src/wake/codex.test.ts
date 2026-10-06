import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeActivity } from '../activity';
import * as activityState from '../activity';
import { appendEntries } from '../inbox';
import { channelFiles, ensureStateDir, openSessionDir, saveSession, writeJsonAtomic, stateRoot, type SessionFiles } from '../state';
import { createCodexWakeDriver, createCodexWaker, type CodexWaker } from './codex';
import { readActivity } from '../activity';
import { readWakeState, settleAttempts, writeWakeSettings } from './shared';
import { createWakeLadder } from './ladder';
import { type CodexIdleWakeOutcome } from './idle-wake';
import { createCodexQueueProcessPort } from './idle-wake-process';

let root: string;
let files: SessionFiles;
let session: SessionFiles;
let time: number;
let waker: CodexWaker | undefined;
let outcome: CodexIdleWakeOutcome;
const diagnostics: string[] = [];
const run = vi.fn<(argv: readonly string[], signal: AbortSignal) => Promise<CodexIdleWakeOutcome>>(async argv => {
  if (outcome.status === 'queued') await settleAttempts(session.dir, { now: time, activity: await readActivity(session), promptText: argv[4]! });
  return outcome;
});
const wait = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
async function append(id: string, kind: 'message' | 'event' = 'message') {
  await appendEntries(files, [{ eventId: id, roomId: 'room', ts: new Date(time).toISOString(), sender: 'sender',
    senderLabel: 'LABELMARK', senderKind: 'human', body: 'BODYMARK', kind }]);
}
async function activity(state: 'idle' | 'busy', at = time - 1) {
  await writeActivity(session, state, () => new Date(at));
}
function start() {
  waker = createCodexWaker({ files: session, threadId: 'thread-1', port: { run }, probe: async () => ({ available: true }), pollMs: 20,
    now: () => time, stderr: line => diagnostics.push(line) });
  waker.notify();
}
describe.each(['legacy', 'nested'])('%s channel layout', layout => {
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-853-waker-'));
  session = await openSessionDir('codex', 'thread-1', { XDG_STATE_HOME: root });
  files = layout === 'legacy' ? session : channelFiles(session, 'room');
  if (layout === 'nested') {
    await ensureStateDir(files.dir);
    await writeJsonAtomic(path.join(files.dir, 'channel.json'), { roomId: 'room', channelName: 'A' });
  }
  time = Date.parse('2026-10-01T00:00:00Z');
  outcome = { status: 'queued' };
  run.mockClear(); diagnostics.length = 0;
});
afterEach(async () => { await waker?.stop(); waker = undefined; vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('queues the fixed notice once for a burst of five appends', async () => {
  await activity('idle'); start();
  for (let i = 0; i < 5; i++) { await append(String(i)); waker!.notify(); }
  await wait();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]).toEqual([['queue', '--thread', 'thread-1', '--message', expect.stringMatching(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/)], expect.any(AbortSignal)]);
});
it('does not wake busy sessions, then wakes when idle', async () => {
  await append('1'); await activity('busy'); start(); await wait(300);
  expect(run).not.toHaveBeenCalled();
  await activity('idle'); await wait(); expect(run).toHaveBeenCalledTimes(1);
});
it('does not wake for events only or missing activity', async () => {
  await append('1', 'event'); await activity('idle'); start(); await wait();
  expect(run).not.toHaveBeenCalled();
  await append('2'); await fs.unlink(path.join(session.dir, 'activity.json')); await wait();
  expect(run).not.toHaveBeenCalled();
});
it('clears pending after a later hook boundary and stops when unread is zero', async () => {
  await append('1'); await activity('idle'); start(); await wait();
  time += 100;
  await activity('busy', time); await wait(); expect(run).toHaveBeenCalledTimes(1);
  await activity('idle', time); await wait(); expect(run).toHaveBeenCalledTimes(2);
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: '1', deliveredCount: 1 });
  time += 100; await activity('idle', time); await wait(); expect(run).toHaveBeenCalledTimes(2);
});
it('allows at most two wakes per cursor count, and permits waking after cursor advances', async () => {
  await append('1'); await append('2'); await activity('idle'); start(); await wait();
  for (let i = 0; i < 3; i++) { time += 60_000; waker!.notify(); await wait(); }
  expect(run).toHaveBeenCalledTimes(2);
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: '1', deliveredCount: 1 });
  waker!.notify(); await wait(); expect(run).toHaveBeenCalledTimes(3);
});
it('resets the attempt cap and pending retry when switching channels at cursor zero', async () => {
  const credentials = { homeserver: 'https://example.test', userId: '@agent-a:example.test',
    accessToken: 'token', deviceId: 'device-a', roomId: layout === 'legacy' ? '!room-a:example.test' : 'room' };
  await saveSession(files, credentials);
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: null, deliveredCount: 0 });
  await append('a'); await activity('idle'); start(); await wait();
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);

  await fs.unlink(files.inbox);
  await fs.unlink(files.cursor);
  await saveSession(files, { ...credentials, userId: '@agent-b:example.test', roomId: layout === 'legacy' ? '!room-b:example.test' : 'room' });
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: null, deliveredCount: 0 });
  await appendEntries(files, [{ eventId: 'b', roomId: layout === 'legacy' ? '!room-b:example.test' : 'room', ts: new Date(time).toISOString(),
    sender: 'sender', senderLabel: 'LABELMARK', senderKind: 'human', body: 'BODYMARK', kind: 'message' }]);
  waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(3);
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(4);
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(4);
});
it('reports failure without content and waits before retrying', async () => {
  outcome = { status: 'exited', code: 1 };
  await append('1'); await activity('idle'); start(); await wait();
  expect(run).toHaveBeenCalledTimes(1);
  expect(diagnostics.map(line => JSON.parse(line))).toEqual([{ ok: false, warning: 'codex_queue_failed', status: 'exited' }]);
  time += 60_001; await wait(); expect(run).toHaveBeenCalledTimes(2);
});
it('coalesces notifications during a queue, aborts it and waits for settlement on stop', async () => {
  await append('1'); await activity('idle');
  let settle!: () => void;
  let signal!: AbortSignal;
  const slow = vi.fn((_argv: readonly string[], abort: AbortSignal) => {
    signal = abort;
    return new Promise<CodexIdleWakeOutcome>(resolve => { settle = () => resolve({ status: 'queued' }); });
  });
  waker = createCodexWaker({ files: session, threadId: 'thread-1', port: { run: slow }, probe: async () => ({ available: true }), pollMs: 20, now: () => time });
  waker.notify(); await wait();
  for (let i = 0; i < 5; i++) waker.notify();
  await wait(); expect(slow).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = waker.stop().then(() => { stopped = true; });
  expect(signal.aborted).toBe(true); await wait(); expect(stopped).toBe(false);
  settle(); await stopping; waker.notify(); await wait(); expect(slow).toHaveBeenCalledTimes(1);
});
it('runs exactly one coalesced reevaluation after an in-flight queue settles', async () => {
  await append('1'); await activity('idle');
  let settle!: () => void;
  const slow = vi.fn().mockImplementationOnce(() => new Promise<CodexIdleWakeOutcome>(resolve => {
    settle = () => resolve({ status: 'queued' });
  })).mockResolvedValue({ status: 'queued' });
  waker = createCodexWaker({ files: session, threadId: 'thread-1', port: { run: slow }, probe: async () => ({ available: true }), pollMs: 100_000, now: () => time });
  waker.notify(); await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
  time += 10; await activity('idle', time);
  for (let i = 0; i < 5; i++) waker.notify();
  settle(); await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
});
it('reports content-free errors and continues after a storage failure', async () => {
  await fs.mkdir(files.inbox); start(); await wait();
  expect(diagnostics.every(line => line === '{"ok":false,"warning":"codex_waker_error"}\n')).toBe(true);
  expect(diagnostics.length).toBeGreaterThan(0);
  await fs.rmdir(files.inbox); await append('1'); await activity('idle'); await wait(); expect(run).toHaveBeenCalledTimes(1);
});
it.each([false, true])('disables queue after two unverified wakes; terminal consent=%s', async consent => {
  const env = { XDG_STATE_HOME: root };
  if (consent) await writeWakeSettings(stateRoot(env), { consent: { 'codex/terminal': { at: new Date(time).toISOString() } }, off: {} });
  const queued = vi.fn().mockResolvedValue({ status: 'queued' });
  const terminal = vi.fn();
  await append('1'); await activity('idle');
  waker = createWakeLadder({ files: session, harness: 'codex', sessionId: 'thread-1', env, now: () => time, pollMs: 100_000,
    drivers: [createCodexWakeDriver({ port: { run: queued }, probe: async () => ({ available: true }) }),
      { id: 'terminal', rung: 4, optIn: true, minIdleMs: 30_000, deadlineMs: 10_000, available: () => true, wake: terminal }] });
  waker.notify(); await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
  time += 60_000; waker.notify(); await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
  time += 30_000; waker.notify();
  await vi.waitFor(async () => expect((await readWakeState(session.dir)).queue).toMatchObject({ disabled: true, failures: 2, reason: 'nonce_timeout' }));
  await wait();
  expect(queued).toHaveBeenCalledTimes(2);
  expect(terminal).toHaveBeenCalledTimes(consent ? 1 : 0);
});
it('rejects invalid thread IDs', () => {
  for (const threadId of ['../x', '', '-x', 'a'.repeat(129)]) {
    expect(() => createCodexWaker({ files: session, threadId })).toThrow('invalid_thread_id');
  }
});
it('uses the real no-shell process runner with scrubbed env and no message marker', async () => {
  const executable = path.join(root, 'codex');
  const dump = path.join(root, 'dump.json');
  await fs.writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`, { mode: 0o700 });
  await append('1'); await activity('idle');
  const port = createCodexQueueProcessPort({ command: 'codex', env: { ...process.env, PATH: root, KHALA_SECRET: 'x' } });
  waker = createCodexWaker({ files: session, threadId: 'thread-1', port, probe: async () => ({ available: true }), pollMs: 20, now: () => time });
  waker.notify();
  await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(dump, 'utf8')).argv).toEqual(['queue', '--thread', 'thread-1', '--message', expect.stringMatching(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/)]));
  const content = await fs.readFile(dump, 'utf8');
  expect(content).not.toContain('KHALA_SECRET'); expect(content).not.toContain('BODYMARK'); expect(content).not.toContain('LABELMARK');
});

it('requires a strictly later hook timestamp and retries at exactly 60 seconds', async () => {
  await append('1'); await activity('idle'); start(); await wait();
  await activity('idle', time); waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(1);
  time += 59_999; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(1);
  time += 1; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
});

it('suppresses async wakes and resumes on sync without moving the cursor', async () => {
  await append('1'); await activity('idle');
  await writeJsonAtomic(files.mode, { mode: 'async' });
  start(); await wait(150);
  expect(run).not.toHaveBeenCalled();
  await writeJsonAtomic(files.mode, { mode: 'sync' });
  waker!.notify();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
});
it('clears a pending wake when async is entered', async () => {
  await append('1'); await activity('idle'); start(); await wait();
  expect(run).toHaveBeenCalledTimes(1);
  await writeJsonAtomic(files.mode, { mode: 'async' });
  waker!.notify(); await wait();
  await writeJsonAtomic(files.mode, { mode: 'steer' });
  waker!.notify();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
});


it('does not queue when mode switches to async during evaluation', async () => {
  await append('1'); await activity('idle');
  await writeJsonAtomic(files.mode, { mode: 'sync' });
  const readActivity = activityState.readActivity;
  const read = vi.spyOn(activityState, 'readActivity').mockImplementationOnce(async target => {
    const current = await readActivity(target);
    await writeJsonAtomic(files.mode, { mode: 'async' });
    return current;
  });
  waker = createCodexWaker({ files: session, threadId: 'thread-1', port: { run }, probe: async () => ({ available: true }), pollMs: 100_000,
    now: () => time, stderr: line => diagnostics.push(line) });
  waker.notify();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await wait();
  expect(run).not.toHaveBeenCalled();
});

async function joinedB(mode = 'sync', messages = 1) {
  const target = channelFiles(session, 'room-b');
  await ensureStateDir(target.dir);
  await writeJsonAtomic(path.join(target.dir, 'channel.json'), { roomId: 'room-b', channelName: 'B' });
  await saveSession(target, { homeserver: 'https://example.test', userId: '@b:example.test', accessToken: 'token', deviceId: 'b', roomId: 'room-b' });
  await writeJsonAtomic(target.mode, { mode });
  await appendEntries(target, Array.from({ length: messages }, (_, i) => ({ eventId: `b${i}`, roomId: 'room-b', ts: new Date(time).toISOString(), sender: 'sender', senderLabel: 'LABELMARK', senderKind: 'human' as const, body: 'BODYMARK', kind: 'message' as const })));
  return target;
}
it('coalesces two sync channels and renews the composite budget after delivery in either', async () => {
  await append('a1'); await append('a2');
  const b = await joinedB('sync', 2);
  await activity('idle'); start();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await append('a3');
  time += 60_000; waker!.notify();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await appendEntries(b, [{ eventId: 'b3', roomId: 'room-b', ts: new Date(time).toISOString(), sender: 'sender', senderLabel: 'LABELMARK', senderKind: 'human', body: 'BODYMARK', kind: 'message' }]);
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  await writeJsonAtomic(b.cursor, { lastDeliveredEventId: 'b0', deliveredCount: 1 });
  const cursor = await fs.readFile(b.cursor);
  waker!.notify();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(await fs.readFile(b.cursor)).toEqual(cursor);
  await expect(fs.readFile(files.cursor)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: 'a1', deliveredCount: 1 });
  time += 60_000; waker!.notify();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
});
it('does not wake for ten unread async messages beside an empty sync channel', async () => {
  await joinedB('async', 10);
  await activity('idle'); start(); await wait();
  expect(run).not.toHaveBeenCalled();
});
it('does not wake for unread async A beside empty sync B', async () => {
  await append('a1'); await writeJsonAtomic(files.mode, { mode: 'async' });
  await joinedB('sync', 0);
  await activity('idle'); start(); await wait();
  expect(run).not.toHaveBeenCalled();
});
it('joining and rejoining an empty channel preserves the other channel wake budget', async () => {
  await append('a1'); await activity('idle'); start(); await wait();
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  const b = await joinedB('sync', 0);
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  await saveSession(b, { homeserver: 'https://example.test', userId: '@rejoined:example.test', accessToken: 'token', deviceId: 'b', roomId: 'room-b' });
  waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  await expect(fs.readFile(files.cursor)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not renew an exhausted cursor budget by toggling async', async () => {
  await append('a1'); await activity('idle'); start(); await wait();
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  await writeJsonAtomic(files.mode, { mode: 'async' });
  waker!.notify(); await wait();
  await writeJsonAtomic(files.mode, { mode: 'sync' });
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
});

it('renews a rejoined channel with the same credentials while preserving other channels', async () => {
  const b = await joinedB();
  await activity('idle'); start(); await wait();
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  await writeJsonAtomic(path.join(b.dir, 'channel.json'), { roomId: 'room-b', channelName: 'B', joinedAt: new Date(time).toISOString() });
  waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(3);
  await expect(fs.readFile(files.cursor)).rejects.toMatchObject({ code: 'ENOENT' });
});

});
