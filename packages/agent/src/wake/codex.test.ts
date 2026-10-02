import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeActivity } from '../activity';
import { appendEntries } from '../inbox';
import { openSessionDir, saveSession, writeJsonAtomic, type SessionFiles } from '../state';
import { createCodexWaker, type CodexWaker } from './codex';
import { CODEX_IDLE_WAKE_NOTICE, type CodexIdleWakeOutcome } from './idle-wake';
import { createCodexQueueProcessPort } from './idle-wake-process';

let root: string;
let files: SessionFiles;
let time: number;
let waker: CodexWaker | undefined;
let outcome: CodexIdleWakeOutcome;
const diagnostics: string[] = [];
const run = vi.fn<(argv: readonly string[], signal: AbortSignal) => Promise<CodexIdleWakeOutcome>>(async () => outcome);
const wait = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
async function append(id: string, kind: 'message' | 'event' = 'message') {
  await appendEntries(files, [{ eventId: id, roomId: 'room', ts: new Date(time).toISOString(), sender: 'sender',
    senderLabel: 'LABELMARK', senderKind: 'human', body: 'BODYMARK', kind }]);
}
async function activity(state: 'idle' | 'busy', at = time - 1) {
  await writeActivity(files, state, () => new Date(at));
}
function start() {
  waker = createCodexWaker({ files, threadId: 'thread-1', port: { run }, pollMs: 20,
    now: () => time, stderr: line => diagnostics.push(line) });
  waker.notify();
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-853-waker-'));
  files = await openSessionDir('codex', 'thread-1', { XDG_STATE_HOME: root });
  time = Date.parse('2026-10-01T00:00:00Z');
  outcome = { status: 'queued' };
  run.mockClear(); diagnostics.length = 0;
});
afterEach(async () => { await waker?.stop(); waker = undefined; await fs.rm(root, { recursive: true, force: true }); });

it('queues the fixed notice once for a burst of five appends', async () => {
  await activity('idle'); start();
  for (let i = 0; i < 5; i++) { await append(String(i)); waker!.notify(); }
  await wait();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]).toEqual([['queue', '--thread', 'thread-1', '--message', CODEX_IDLE_WAKE_NOTICE], expect.any(AbortSignal)]);
});
it('does not wake busy sessions, then wakes when idle', async () => {
  await append('1'); await activity('busy'); start(); await wait(300);
  expect(run).not.toHaveBeenCalled();
  await activity('idle'); await wait(); expect(run).toHaveBeenCalledTimes(1);
});
it('does not wake for events only or missing activity', async () => {
  await append('1', 'event'); await activity('idle'); start(); await wait();
  expect(run).not.toHaveBeenCalled();
  await append('2'); await fs.unlink(path.join(files.dir, 'activity.json')); await wait();
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
    accessToken: 'token', deviceId: 'device-a', roomId: '!room-a:example.test' };
  await saveSession(files, credentials);
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: null, deliveredCount: 0 });
  await append('a'); await activity('idle'); start(); await wait();
  time += 60_000; waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);
  waker!.notify(); await wait();
  expect(run).toHaveBeenCalledTimes(2);

  await fs.unlink(files.inbox);
  await fs.unlink(files.cursor);
  await saveSession(files, { ...credentials, userId: '@agent-b:example.test', roomId: '!room-b:example.test' });
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: null, deliveredCount: 0 });
  await appendEntries(files, [{ eventId: 'b', roomId: '!room-b:example.test', ts: new Date(time).toISOString(),
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
  waker = createCodexWaker({ files, threadId: 'thread-1', port: { run: slow }, pollMs: 20, now: () => time });
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
  waker = createCodexWaker({ files, threadId: 'thread-1', port: { run: slow }, pollMs: 100_000, now: () => time });
  waker.notify(); await wait(); time += 10; await activity('idle', time);
  for (let i = 0; i < 5; i++) waker.notify();
  settle(); await wait(); expect(slow).toHaveBeenCalledTimes(2);
});
it('reports content-free errors and continues after a storage failure', async () => {
  await fs.mkdir(files.inbox); start(); await wait();
  expect(diagnostics.every(line => line === '{"ok":false,"warning":"codex_waker_error"}\n')).toBe(true);
  expect(diagnostics.length).toBeGreaterThan(0);
  await fs.rmdir(files.inbox); await append('1'); await activity('idle'); await wait(); expect(run).toHaveBeenCalledTimes(1);
});
it('rejects invalid thread IDs', () => {
  for (const threadId of ['../x', '', '-x', 'a'.repeat(129)]) {
    expect(() => createCodexWaker({ files, threadId })).toThrow('invalid_thread_id');
  }
});
it('uses the real no-shell process runner with scrubbed env and no message marker', async () => {
  const executable = path.join(root, 'codex');
  const dump = path.join(root, 'dump.json');
  await fs.writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`, { mode: 0o700 });
  await append('1'); await activity('idle');
  const port = createCodexQueueProcessPort({ command: 'codex', env: { ...process.env, PATH: root, KHALA_SECRET: 'x' } });
  waker = createCodexWaker({ files, threadId: 'thread-1', port, pollMs: 20, now: () => time });
  waker.notify();
  await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(dump, 'utf8')).argv).toEqual(['queue', '--thread', 'thread-1', '--message', CODEX_IDLE_WAKE_NOTICE]));
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
