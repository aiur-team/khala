import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverCore, type HookIO } from './deliver-core';
import { adapterFor } from './index';
import { hookMapSource } from './session-sources';
import type { DeliverCodec } from './adapter';
import { openSessionDir, type SessionFiles } from '../state';
import { appendEntries, readCursor } from '../inbox';
import { readActivity } from '../activity';

let root: string, files: SessionFiles, io: HookIO;
let stdout: string, stderr: string;
const instant = new Date('2026-10-05T12:00:00Z');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-deliver-core-'));
  files = await openSessionDir('codex', 'session', { XDG_STATE_HOME: root });
  await appendEntries(files, [{ eventId: '$event', roomId: '!room', ts: instant.toISOString(),
    sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'event', body: 'CI passed' }]);
  stdout = ''; stderr = '';
  io = { env: { XDG_STATE_HOME: root }, now: () => instant,
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('uses normalized codec input and renders only after the cursor advances', async () => {
  const codec: DeliverCodec = { ...adapterFor('codex')!.codec!,
    parse: vi.fn<DeliverCodec['parse']>(() => ({ sessionId: 'session', event: 'prompt', continuation: false })),
    render: vi.fn((kind, frame) => `${kind}:${frame}`) };
  expect(await deliverCore('dialect-owned input', { ...adapterFor('codex')!, codec }, io)).toBe(0);
  expect(codec.parse).toHaveBeenCalledWith('dialect-owned input');
  expect(codec.render).toHaveBeenCalledOnce();
  expect(stdout).toContain('prompt:<khala-channel-messages');
  expect((await readCursor(files)).deliveredCount).toBe(1);
  expect(await readActivity(files)).toEqual({ state: 'busy', updatedAt: instant.toISOString() });
  expect(stderr).toBe('');
});
it('uses the codec wake policy without consuming event-only prompt frames', async () => {
  const codec: DeliverCodec = { ...adapterFor('codex')!.codec!, promptDeliversWithoutWake: false };
  await deliverCore('{"session_id":"session","hook_event_name":"UserPromptSubmit"}', { ...adapterFor('codex')!, codec }, io);
  expect(stdout).toBe('');
  expect((await readCursor(files)).deliveredCount).toBe(0);
  expect((await readActivity(files)).state).toBe('busy');
});
it('finds an active fallback session through codec metadata', async () => {
  const codec: DeliverCodec = { ...adapterFor('codex')!.codec!, fallbackSession: 'session' };
  await deliverCore('{"session_id":"missing","hook_event_name":"UserPromptSubmit"}', { ...adapterFor('codex')!, codec }, io);
  expect(stdout).toContain('CI passed');
  expect((await readCursor(files)).deliveredCount).toBe(1);
});
it('bounds normalized stop continuations without consuming entries', async () => {
  await deliverCore('{"session_id":"session","hook_event_name":"Stop","stop_hook_active":true}', adapterFor('codex')!, io);
  expect(stdout).toBe('');
  expect((await readCursor(files)).deliveredCount).toBe(0);
  expect((await readActivity(files)).state).toBe('idle');
});
it.each(['claude', 'cursor'])('preserves %s closed-pipe handling without rejecting the hook', async harness => {
  io.stdout.write = () => { throw new Error('closed pipe with private details'); };
  const stdin = harness === 'claude'
    ? '{"session_id":"session","hook_event_name":"UserPromptSubmit"}'
    : '{"hook_event_name":"beforeSubmitPrompt"}';
  if (harness === 'claude') {
    const active = await openSessionDir('claude', 'session', io.env);
    await appendEntries(active, [{ eventId: '$message', roomId: '!room', ts: instant.toISOString(),
      sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'hello' }]);
  }
  expect(await deliverCore(stdin, adapterFor(harness)!, io)).toBe(0);
  expect(stderr).toBe(harness === 'claude'
    ? '{"ok":false,"warning":"khala_hook_suppressed","code":"internal_error"}\n' : '');
});

it('suppresses mapping storage failures and still delivers the joined session frame', async () => {
  await fs.mkdir(path.join(path.dirname(files.dir), '.by-pid', '100.json'), { recursive: true, mode: 0o700 });
  io.pid = 300;
  io.readProcess = async pid => pid === 300
    ? { pid: 300, ppid: 100, startTime: '300', command: 'hook' }
    : pid === 100 ? { pid: 100, ppid: 0, startTime: '100', command: 'harness' } : null;
  expect(await deliverCore('{"session_id":"session","hook_event_name":"UserPromptSubmit"}',
    { ...adapterFor('codex')!, sessionSources: [hookMapSource] }, io)).toBe(0);
  expect(stdout).toContain('CI passed');
  expect((await readCursor(files)).deliveredCount).toBe(1);
  expect(JSON.parse(stderr)).toEqual({ ok: false, warning: 'khala_hook_suppressed', code: 'storage_failed' });
});

it('verifies the prompt nonce before recording busy activity', async () => {
  const { recordAttempt, readWakeState, settleAttempts } = await import('../wake/shared/nonce');
  const { writeActivity } = await import('../activity');
  const at = instant.getTime();
  await writeActivity(files, 'idle', () => new Date(at - 1000));
  await recordAttempt(files.dir, { driver: 'native', nonce: '12345678', at: at - 500, deadline: at - 100 });
  await settleAttempts(files.dir, { now: at - 100, activity: await readActivity(files) });
  expect((await readWakeState(files.dir)).native?.failures).toBe(1);
  await recordAttempt(files.dir, { driver: 'native', nonce: '87654321', at: at - 50, deadline: at + 30_000 });
  await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name: 'UserPromptSubmit',
    prompt: 'Khala: channel messages are waiting. Continue. (k-87654321)' }), adapterFor('codex')!, io);
  expect((await readWakeState(files.dir)).native?.failures).toBe(0);
  expect((await readActivity(files)).state).toBe('busy');
});

it('voids an unverified wake when a user prompt arrives', async () => {
  const { recordAttempt, readWakeState } = await import('../wake/shared/nonce');
  await recordAttempt(files.dir, { driver: 'terminal', nonce: '12345678',
    at: instant.getTime() - 100, deadline: instant.getTime() + 10_000 });
  await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name: 'UserPromptSubmit',
    prompt: 'Please continue my task' }), adapterFor('codex')!, io);
  expect((await readWakeState(files.dir)).terminal?.failures ?? 0).toBe(0);
});

it('keeps prompt delivery and busy activity when verification state is corrupt', async () => {
  await fs.writeFile(path.join(files.dir, 'wake-journal.json'), 'not-json');
  await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name: 'UserPromptSubmit', prompt: 'hello' }), adapterFor('codex')!, io);
  expect(stdout).toContain('CI passed');
  expect((await readActivity(files)).state).toBe('busy');
  expect(stderr).toContain('wake_verification_failed');
});

it('delivers a disable notice on the next frame only once', async () => {
  const { recordAttempt, settleAttempts } = await import('../wake/shared');
  for (const [nonce, at] of [['12345678', 100], ['abcdef12', 200]] as const) {
    await recordAttempt(files.dir, { driver: 'terminal', nonce, at, deadline: at + 10 });
    await settleAttempts(files.dir, { now: at + 10, activity: { state: 'idle', updatedAt: 0 } });
  }
  const input = '{"session_id":"session","hook_event_name":"UserPromptSubmit"}';
  await deliverCore(input, adapterFor('codex')!, io);
  expect(stdout).toContain('Idle wake (terminal)');
  expect(stdout).toContain('khala wake on --driver terminal');
  stdout = '';
  await appendEntries(files, [{ eventId: '$second', roomId: '!room', ts: instant.toISOString(), sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'next' }]);
  await deliverCore(input, adapterFor('codex')!, io);
  expect(stdout).toContain('next');
  expect(stdout).not.toContain('Idle wake (terminal)');
});

it.each(['claude', 'codex', 'cursor'])('does not walk processes or create hook mappings for registered %s hooks', async harness => {
  const readProcess = vi.fn<NonNullable<HookIO['readProcess']>>();
  io.readProcess = readProcess;
  for (const hook_event_name of harness === 'cursor' ? ['beforeSubmitPrompt'] : ['SessionStart', 'UserPromptSubmit']) {
    expect(await deliverCore(JSON.stringify({ session_id: 'unjoined', hook_event_name,
      conversation_id: 'unjoined', workspace_roots: ['/work/unjoined'] }), adapterFor(harness)!, io)).toBe(0);
  }
  expect(readProcess).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(root, 'khala', harness, '.by-pid'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(stderr).toBe('');
});
