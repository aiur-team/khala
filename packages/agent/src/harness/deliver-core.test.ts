import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverCore, type HookIO } from './deliver-core';
import { adapterFor } from './index';
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
