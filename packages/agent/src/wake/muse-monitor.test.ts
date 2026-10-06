import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readActivity, writeActivity } from '../activity';
import { appendEntries, readCursor } from '../inbox';
import { openSessionDir, writeJsonAtomic, writeStatus, type SessionFiles } from '../state';
import { watchSession, monitorArmed } from '../watch';
import { recordAttempt, readWakeState, writeWakeSettings, settleAttempts } from './shared';
import { deliverCore } from '../harness/deliver-core';
import { muse } from '../harness/muse';
import { createMuseMonitorDriver, museWatchCommand, MUSE_WAKE_REQUEST, museJournalPath, museStopWakeText } from './muse-monitor';

const sessionId = '01a10fee-e403-7390-b3a0-dd772e9d2ef7';
const line = 'Khala: channel messages are waiting. Continue. (k-deadbeef)';
const at = Date.parse('2026-10-05T12:00:00Z');
let root: string, files: SessionFiles, env: NodeJS.ProcessEnv, controller: AbortController;
let watching: Promise<number> | undefined;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-muse-monitor-'));
  env = { XDG_STATE_HOME: root, XDG_DATA_HOME: path.join(root, 'data') };
  files = await openSessionDir('muse', sessionId, env);
  await writeJsonAtomic(files.session, { userId: '@self:test', roomId: '!room:test' });
  await writeStatus(files, 'connected');
  await writeActivity(files, 'idle', () => new Date(at));
  controller = new AbortController();
});
afterEach(async () => { controller.abort(); await watching; watching = undefined; await fs.rm(root, { recursive: true, force: true }); });
const context = () => ({ files, harness: 'muse', sessionId, env, signal: controller.signal, now: at });
type MuseRecord = { stream: { id: string }; recorded_at: number; payload: { run_id: string; event: { kind: string;
  drain_target_run_stream: { id: string }; delivery_snapshot: { body: string; source: { source: string } } } } };
async function journal(overrides?: (record: MuseRecord) => void) {
  const record = JSON.parse(await fs.readFile(new URL('../../../../docs/build/multi-harness/spikes/muse-fixtures/monitor/inbox-item-drained.json', import.meta.url), 'utf8'));
  record.stream.id = sessionId;
  record.recorded_at = (at + 1) * 1000;
  record.payload.run_id = 'run';
  record.payload.event.drain_target_run_stream.id = 'run';
  record.payload.event.delivery_snapshot.body = line;
  overrides?.(record);
  const file = museJournalPath(sessionId, env)!;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record) + '\n');
  return file;
}
const stop = () => JSON.stringify({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'run', stop_hook_active: false });
it('invokes the Windows monitor launcher with PowerShell quoting', () => {
  expect(museWatchCommand(sessionId, "C:\\Users\\Ada O'Brien\\khala.cmd", 'win32'))
    .toBe(`& 'C:\\Users\\Ada O''Brien\\khala.cmd' watch --harness muse --session '${sessionId}'`);
  expect(museWatchCommand(sessionId, '/home/ada/khala', 'linux'))
    .toBe(`'/home/ada/khala' watch --harness muse --session '${sessionId}'`);
});
it('reports an unarmed native monitor unavailable, including Windows, and never uses peer messaging', async () => {
  const driver = createMuseMonitorDriver();
  expect(await driver.available(context())).toBe(false);
  expect(await driver.unavailableReason?.(context())).toBe('monitor_missing');
  expect(await driver.wake(context(), line)).toBe('skipped');
  expect(await fs.readdir(files.dir)).not.toContain(MUSE_WAKE_REQUEST);
});
it('sends only the fixed nonce notice through the live watcher, without raw content, and respects off/async/busy', async () => {
  const lines: string[] = [];
  watching = watchSession(files, { harness: 'muse', env, now: () => at, signal: controller.signal, write: text => { lines.push(text); } });
  await vi.waitFor(async () => expect(await monitorArmed(files)).toBe(true));
  const driver = createMuseMonitorDriver();
  expect(await driver.available(context())).toBe(true);
  await appendEntries(files, [{ kind: 'message', eventId: '$one', roomId: '!room:test', ts: new Date(at).toISOString(), sender: '@peer:test', senderLabel: 'Peer', senderKind: 'human', body: 'BODYMARK' }]);
  await writeWakeSettings(path.join(root, 'khala'), { consent: {}, off: { 'muse/monitor': { at: new Date(at).toISOString() } } });
  await driver.wake(context(), line);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(lines).toEqual([]);
  await writeJsonAtomic(files.mode, { mode: 'async' });
  await writeWakeSettings(path.join(root, 'khala'), { consent: {}, off: {} });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(lines).toEqual([]);
  await writeActivity(files, 'busy', () => new Date(at));
  await writeJsonAtomic(files.mode, { mode: 'sync' });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(lines).toEqual([]);
  await writeActivity(files, 'idle', () => new Date(at));
  await vi.waitFor(() => expect(lines).toEqual([line + '\n']));
  expect((await readActivity(files)).state).toBe('idle');
  expect(await driver.wake(context(), line.replace('deadbeef', '12345678'))).toBe('skipped');
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(lines).toEqual([line + '\n']);
  await settleAttempts(files.dir, { now: at + 60_000, activity: await readActivity(files) });
  expect((await readWakeState(files.dir)).monitor?.failures ?? 0).toBe(0);
  await expect(driver.wake(context(), 'BODYMARK')).rejects.toThrow('invalid_monitor_wake_line');
});
it('settles the nonce only at Stop for a drained native notification in the same run, even after tool activity', async () => {
  await writeJsonAtomic(path.join(files.dir, MUSE_WAKE_REQUEST), { owner: 'lease', line, at, deadline: at + 30_000, journalOffset: 0 });
  await journal();
  await recordAttempt(files.dir, { nonce: 'deadbeef', driver: 'monitor', at, deadline: at + 30_000 });
  await writeActivity(files, 'busy', () => new Date(at + 10));
  await deliverCore(stop(), muse, { env, now: () => new Date(at + 20), stdout: { write: () => {} }, stderr: { write: () => {} } });
  expect((await readWakeState(files.dir)).monitor).toEqual({ failures: 0 });
  expect((await readActivity(files)).state).toBe('idle');
});
it.each(['sync', 'steer'])('delivers an idle wake through %s hooks once without UserPromptSubmit', async mode => {
  await writeJsonAtomic(files.mode, { mode });
  await appendEntries(files, [{ kind: 'message', eventId: '$mention', roomId: '!room:test',
    ts: new Date(at).toISOString(), sender: '@peer:test', senderLabel: 'Peer', senderKind: 'human', body: '@Scout BODYMARK' }]);
  await writeJsonAtomic(path.join(files.dir, MUSE_WAKE_REQUEST), { owner: 'lease', line, at, deadline: at + 30_000, journalOffset: 0 });
  await journal();
  await recordAttempt(files.dir, { nonce: 'deadbeef', driver: 'monitor', at, deadline: at + 30_000 });
  const outputs: string[] = [];
  const io = { env, now: () => new Date(at + 20), stdout: { write: (text: string) => { outputs.push(text); } }, stderr: { write: () => {} } };
  await deliverCore(JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolUse' }), muse, io);
  expect(outputs.some(text => text.includes('BODYMARK'))).toBe(mode === 'steer');
  await deliverCore(stop(), muse, io);
  await deliverCore(JSON.stringify({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'run', stop_hook_active: true }), muse, io);
  await deliverCore(stop(), muse, io);
  expect(outputs.filter(text => text.includes('BODYMARK'))).toHaveLength(1);
  expect(await readCursor(files)).toEqual({ lastDeliveredEventId: '$mention', deliveredCount: 1 });
  expect((await readWakeState(files.dir)).monitor).toEqual({ failures: 0 });
});
it.each(['wrong-run', 'wrong-session', 'queued', 'foreign-source', 'wrong-nonce', 'stale'])('rejects %s evidence', async kind => {
  await writeJsonAtomic(path.join(files.dir, MUSE_WAKE_REQUEST), { owner: 'lease', line, at, deadline: at + 30_000, journalOffset: 0 });
  await journal(record => {
    if (kind === 'wrong-run') record.payload.run_id = 'other';
    if (kind === 'wrong-session') record.stream.id = 'other';
    if (kind === 'queued') record.payload.event.kind = 'inbox_item_queued';
    if (kind === 'foreign-source') record.payload.event.delivery_snapshot.source.source = 'session_message';
    if (kind === 'wrong-nonce') record.payload.event.delivery_snapshot.body = line.replace('deadbeef', '12345678');
    if (kind === 'stale') record.recorded_at = (at - 1) * 1000;
  });
  expect(await museStopWakeText(stop(), files, env)).toBeUndefined();
});
it('rejects replay before the recorded journal offset and reads ingress before a large tool log', async () => {
  const file = await journal();
  const offset = (await fs.stat(file)).size;
  await writeJsonAtomic(path.join(files.dir, MUSE_WAKE_REQUEST), { owner: 'lease', line, at, deadline: at + 30_000, journalOffset: offset });
  expect(await museStopWakeText(stop(), files, env)).toBeUndefined();
  await writeJsonAtomic(path.join(files.dir, MUSE_WAKE_REQUEST), { owner: 'lease', line, at, deadline: at + 30_000, journalOffset: 0 });
  await fs.appendFile(file, JSON.stringify({ toolOutput: 'x'.repeat(300_000) }) + '\n');
  expect(await museStopWakeText(stop(), files, env)).toEqual({ text: line, at: at + 1 });
});

it('polls native ingress before activity voiding and confirms late Stop with ingress time', async () => {
  await writeJsonAtomic(path.join(files.dir, MUSE_WAKE_REQUEST), { owner: 'lease', line, at, deadline: at + 30_000, journalOffset: 0 });
  await journal();
  await recordAttempt(files.dir, { nonce: 'deadbeef', driver: 'monitor', at, deadline: at + 30_000 });
  await writeActivity(files, 'busy', () => new Date(at + 10));
  await createMuseMonitorDriver().verify!({ ...context(), now: at + 60_000 });
  await settleAttempts(files.dir, { now: at + 60_000, activity: await readActivity(files) });
  expect((await readWakeState(files.dir)).monitor).toEqual({ failures: 0 });
  await recordAttempt(files.dir, { nonce: 'deadbeef', driver: 'monitor', at, deadline: at + 30_000 });
  await deliverCore(stop(), muse, { env, now: () => new Date(at + 60_000), stdout: { write: () => {} }, stderr: { write: () => {} } });
  expect((await readWakeState(files.dir)).monitor).toEqual({ failures: 0 });
});

it('runs the stable watcher bin without khala on PATH or inherited MUSE_SESSION_ID', async () => {
  const script = fileURLToPath(new URL('../../bin/khala.mjs', import.meta.url));
  const bin = path.join(root, 'bin', 'khala');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.symlink(script, bin);
  const command = museWatchCommand('unjoined-muse', bin);
  expect(command).toContain(' --session ');
  const result = spawnSync('/bin/sh', ['-c', command], { env: { HOME: root, XDG_STATE_HOME: root, PATH: path.dirname(process.execPath) }, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).not.toContain('session_unknown');
});
