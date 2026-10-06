import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendEntries } from '../inbox';
import { openSessionDir, writeStateFile, stateRoot, type SessionFiles } from '../state';
import { writeActivity } from '../activity';
import { readWakeState, settleAttempts, writeWakeSettings } from './shared';
import { opencodeWakeDriver, pollOpenCodeWake } from './opencode';

let root: string, files: SessionFiles, at: number;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-opencode-wake-'));
  files = await openSessionDir('opencode', 'ses_1', { XDG_STATE_HOME: root });
  at = Date.parse('2026-10-05T12:00:00Z');
  await writeStateFile(files.dir, 'session.json', { roomId: '!room', userId: '@self' });
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' });
  await writeActivity(files, 'idle', () => new Date(at));
  await appendEntries(files, [{ eventId: '$message', roomId: '!room', ts: new Date(at).toISOString(),
    sender: '@peer', senderLabel: 'Peer', senderKind: 'human', kind: 'message', body: 'hello' }]);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const io = () => ({ env: { XDG_STATE_HOME: root }, now: () => new Date(at), stdout: { write() {} }, stderr: { write() {} } });
it('publishes one native signal across concurrent polls and verifies its nonce', async () => {
  const outputs = await Promise.all([pollOpenCodeWake(files, io()), pollOpenCodeWake(files, io())]);
  const lines = outputs.filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/);
  expect(await pollOpenCodeWake(files, io())).toBeUndefined();
  const result = await settleAttempts(files.dir, { now: at + 1, activity: { state: 'idle', updatedAt: new Date(at).toISOString() }, promptText: lines[0]! });
  expect(result.map(item => item.status)).toEqual(['success']);
});
it('expires unpublished signals, bounds retries and disables after two nonce failures', async () => {
  expect(await pollOpenCodeWake(files, io())).toBeDefined();
  at += 60_000;
  expect(await pollOpenCodeWake(files, io())).toBeDefined();
  at += 60_000;
  expect(await pollOpenCodeWake(files, io())).toBeUndefined();
  expect((await readWakeState(files.dir))[opencodeWakeDriver.id]).toMatchObject({ failures: 2, disabled: true });
});
it.each(['async', 'busy', 'off'])('suppresses %s including a previously queued signal', async guard => {
  await opencodeWakeDriver.wake({ files, harness: 'opencode', sessionId: 'ses_1', env: io().env, now: at, signal: new AbortController().signal }, 'Khala: channel messages are waiting. Continue. (k-1234abcd)');
  if (guard === 'async') await writeStateFile(files.dir, 'mode.json', { mode: 'async' });
  if (guard === 'busy') await writeActivity(files, 'busy', () => new Date(at));
  if (guard === 'off') await writeWakeSettings(stateRoot(io().env), { consent: {}, off: { 'opencode/opencode-native': { at: new Date(at).toISOString() } } });
  expect(await pollOpenCodeWake(files, io())).toBeUndefined();
});

it('rechecks wake policy and refreshes the nonce when replaying an acknowledged frame', async () => {
  const original = await pollOpenCodeWake(files, io());
  await writeStateFile(files.dir, 'mode.json', { mode: 'async' });
  expect(await pollOpenCodeWake(files, io(), true)).toBeUndefined();
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' });
  await writeWakeSettings(stateRoot(io().env), { consent: {}, off: { 'opencode/opencode-native': { at: new Date(at).toISOString() } } });
  expect(await pollOpenCodeWake(files, io(), true)).toBeUndefined();
  await writeWakeSettings(stateRoot(io().env), { consent: {}, off: {} });
  const fresh = await pollOpenCodeWake(files, io(), true);
  expect(fresh).toBeDefined();
  expect(fresh).not.toBe(original);
  expect(fresh).toMatch(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/);
});
