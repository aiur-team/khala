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
import { readActivity, writeActivity } from '../activity';

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

it.each(['codex', 'claude', 'cursor'] as const)('leaves both wake files unchanged on a %s prompt with no pending wake', async harness => {
  const adapter = adapterFor(harness)!;
  const codec: DeliverCodec = { ...adapter.codec!, parse: () => ({ sessionId: 'session', event: 'prompt', continuation: false, promptText: 'hello' }) };
  const active = await openSessionDir(harness, 'session', io.env);
  const journal = path.join(active.dir, 'wake-journal.json');
  const state = path.join(active.dir, 'wake-state.json');
  await fs.writeFile(journal, '{ "attempts": [], "state": {"native":{"failures":1}} }');
  await fs.writeFile(state, '{ "native": {"failures":1} }');
  const snapshot = async (file: string) => {
    const body = await fs.readFile(file, 'utf8');
    const { mtimeMs, ctimeMs, ino } = await fs.stat(file);
    return { body, mtimeMs, ctimeMs, ino };
  };
  const before = await Promise.all([journal, state].map(snapshot));
  expect(await deliverCore('prompt', { ...adapter, codec }, io)).toBe(0);
  const after = await Promise.all([journal, state].map(snapshot));
  expect(after).toEqual(before);
  await expect(fs.stat(path.join(active.dir, 'wake.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readActivity(active)).state).toBe('busy');
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

it.each(['SessionStart', 'UserPromptSubmit'])('captures the own pane during a joined %s hook', async hook_event_name => {
  io.env.TMUX = '/tmp/test-tmux,10,0';
  io.env.TMUX_PANE = '%7';
  io.pid = 300;
  io.readProcess = async pid => ({ pid, ppid: pid === 300 ? 200 : pid === 200 ? 100 : 0,
    command: pid === 200 ? 'sh' : pid === 100 ? 'codex' : 'khala', startTime: String(pid) });
  await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name }), adapterFor('codex')!, io);
  expect(JSON.parse(await fs.readFile(path.join(files.dir, 'pane.json'), 'utf8'))).toMatchObject({
    kind: 'tmux', paneId: '%7', socket: '/tmp/test-tmux', agentPid: 100, capturedAt: instant.toISOString(),
  });
  if (hook_event_name === 'SessionStart') {
    expect(stdout).toBe('');
    expect((await readCursor(files)).deliveredCount).toBe(0);
    await expect(fs.stat(path.join(files.dir, 'activity.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } else expect((await readActivity(files)).state).toBe('busy');
  expect(stderr).toBe('');
});

it.each(['PostToolUse', 'Stop'])('does not recapture a pane during %s', async hook_event_name => {
  io.env.TMUX = '/tmp/test-tmux,10,0'; io.env.TMUX_PANE = '%7';
  io.readProcess = vi.fn();
  await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name }), adapterFor('codex')!, io);
  expect(io.readProcess).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(files.dir, 'pane.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not capture terminal metadata for an adapter without an empty-prompt guard', async () => {
  const adapter = { ...adapterFor('codex')! };
  delete adapter.emptyPrompt;
  io.env.TMUX = '/tmp/test-tmux,10,0'; io.env.TMUX_PANE = '%7';
  io.readProcess = vi.fn();
  await deliverCore('{"session_id":"session","hook_event_name":"UserPromptSubmit"}', adapter, io);
  expect(io.readProcess).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(files.dir, 'pane.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(stdout).toContain('CI passed');
});

it.each(['sync', 'steer', 'async'] as const)('preserves %s delivery boundaries when Monitor submits a busy Claude prompt', async mode => {
  const active = await openSessionDir('claude', 'session', io.env);
  await fs.writeFile(active.mode, JSON.stringify({ mode }));
  const hook = (event: string, extra = {}) => deliverCore(JSON.stringify({
    session_id: 'session', hook_event_name: event, ...extra,
  }), adapterFor('claude')!, io);
  await writeActivity(active, 'idle', io.now);
  await hook('UserPromptSubmit', { prompt: 'Run two sleeps, then answer sleeps done' });
  await appendEntries(active, [{ eventId: '$mid-turn', roomId: '!room', ts: instant.toISOString(),
    sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'sync-msg-1 mid-turn note' }]);
  await hook('UserPromptSubmit', { prompt: 'Monitor event: khala: 1 new message in #room (0 mentions you)' });
  expect(stdout.includes('sync-msg-1')).toBe(mode === 'steer');
  expect((await readCursor(active)).deliveredCount).toBe(mode === 'steer' ? 1 : 0);
  stdout = '';
  await hook('PostToolUse');
  expect(stdout).toBe('');
  await appendEntries(active, [{ eventId: '$tool-boundary', roomId: '!room', ts: instant.toISOString(),
    sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'second note' }]);
  await hook('PostToolUse');
  expect(stdout.includes('second note')).toBe(mode === 'steer');
  expect((await readCursor(active)).deliveredCount).toBe(mode === 'steer' ? 2 : 0);
  stdout = '';
  await hook('Stop');
  if (mode === 'sync') {
    expect(JSON.parse(stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('sync-msg-1') });
    expect(stdout).toContain('second note');
    expect((await readCursor(active)).deliveredCount).toBe(2);
    stdout = '';
    await hook('Stop', { stop_hook_active: true });
  } else {
    expect(stdout).toBe('');
    expect((await readCursor(active)).deliveredCount).toBe(mode === 'steer' ? 2 : 0);
  }
  expect((await readActivity(active)).state).toBe('idle');
});

it('delivers Sync on an idle Claude Monitor mention and at the next idle user prompt', async () => {
  const active = await openSessionDir('claude', 'session', io.env);
  await fs.writeFile(active.mode, JSON.stringify({ mode: 'sync' }));
  for (const prompt of ['Monitor event: khala: 1 new message in #room (1 mentions you)', 'Continue my task']) {
    await writeActivity(active, 'idle', io.now);
    await appendEntries(active, [{ eventId: prompt, roomId: '!room', ts: instant.toISOString(),
      sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: '@Scout hello' }]);
    stdout = '';
    await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name: 'UserPromptSubmit', prompt }), adapterFor('claude')!, io);
    expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('@Scout hello') });
    expect((await readActivity(active)).state).toBe('busy');
  }
  expect((await readCursor(active)).deliveredCount).toBe(2);
});
