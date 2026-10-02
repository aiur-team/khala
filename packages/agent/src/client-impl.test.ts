import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { requestJoin, pollJoin, reportReady } from './join';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { KhalaAgentClient } from './client';
import { KhalaClientError } from './client';
import { createKhalaAgentClient } from './client-impl';
import type { AgentMatrixSession, SessionMessage } from './matrix/session';
import { appendInbox } from './inbox';
import { ensureStateDir, readStateFile, resolveStateDir, writeStateFile } from './state';
import { toInboxEntry } from './sender';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const credentials: AgentCredentials = { homeserver: 'https://matrix.example', userId: '@agent-123-456:s', accessToken: 'SECRET', deviceId: 'd', roomId: '!r:s' };
const link = 'https://khala.example/join/abcdefgh';
const created = { origin: 'https://khala.example', joinId: 'j', pollSecret: 'POLL', confirmUrl: 'https://khala.example/agent/confirm', expiresAt: '2026-10-03T00:00:00Z' };
const now = () => new Date('2026-10-02T00:00:00Z');
const message = (eventId: string, sender = '@khala_abc:s'): SessionMessage => ({ eventId, sender, roomId: credentials.roomId, ts: now().getTime(), type: 'm.room.message', body: eventId, content: {} });
let root: string;
let dir: string;
let client: KhalaAgentClient;
let poll: ReturnType<typeof deferred<AgentCredentials>>;
let handler: ((message: SessionMessage) => void) | undefined;
let session: AgentMatrixSession;
let joinApi: { requestJoin: Mock<typeof requestJoin>; pollJoin: Mock<typeof pollJoin>; reportReady: Mock<typeof reportReady> };
let waker: Mock<(entry: InboxEntry) => void>;
let startSession: Mock<(credentials: AgentCredentials) => Promise<AgentMatrixSession>>;
const statusFile = () => readStateFile<Record<string, unknown>>(dir, 'status.json');
async function connected() {
  await client.join(link, 'Codex');
  poll.resolve(credentials);
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
}
async function entries() {
  await client.status();
  try { return (await fs.readFile(path.join(dir, 'inbox.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch { return []; }
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-client-849-'));
  dir = resolveStateDir('codex', 'test', { XDG_STATE_HOME: root });
  poll = deferred<AgentCredentials>();
  handler = undefined;
  session = {
    userId: credentials.userId,
    onMessage: vi.fn(callback => { handler = callback; return () => { handler = undefined; }; }),
    waitForInvite: vi.fn(async () => {}), join: vi.fn(async () => {}),
    history: vi.fn(async () => ({ messages: [] })), send: vi.fn(async () => ({ eventId: '$sent' })),
    sendChannelEvent: vi.fn(async () => ({ eventId: '$event' })),
    roomName: vi.fn(() => 'Release room'), displayName: vi.fn(id => id === '@khala_abc:s' ? 'Maya' : undefined),
    stop: vi.fn(async () => {}),
  };
  joinApi = { requestJoin: vi.fn(async () => created), pollJoin: vi.fn(() => poll.promise), reportReady: vi.fn(async () => {}) };
  waker = vi.fn(); startSession = vi.fn(async () => session);
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi, onInboxAppend: waker });
});
afterEach(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
it('returns promptly, persists private join state and coalesces simultaneous requests', async () => {
  expect(await Promise.all([client.join(link, 'Codex'), client.join(link, 'Codex')])).toEqual([
    { state: 'awaiting_confirmation', confirmUrl: created.confirmUrl }, { state: 'awaiting_confirmation', confirmUrl: created.confirmUrl },
  ]);
  expect(joinApi.requestJoin).toHaveBeenCalledTimes(1);
  expect(await readStateFile(dir, 'join.json')).toEqual({ joinId: 'j', pollSecret: 'POLL', confirmUrl: created.confirmUrl, expiresAt: created.expiresAt, link });
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(dir, 'join.json'))).mode & 0o777).toBe(0o600);
  expect(await statusFile()).toEqual({ state: 'joining', updatedAt: now().toISOString() });
});
it('runs the handshake in order and exposes a connected client', async () => {
  await connected();
  expect(await client.status()).toEqual({ state: 'connected', channelName: 'Release room', agentUserId: credentials.userId, unread: 0 });
  const calls = [joinApi.pollJoin, startSession, session.onMessage, joinApi.reportReady, session.waitForInvite, session.join].map(fn => vi.mocked(fn).mock.invocationCallOrder[0]!);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));
  expect(session.waitForInvite).toHaveBeenCalledWith(credentials.roomId, 120_000);
  expect(await readStateFile(dir, 'session.json')).toEqual(credentials);
  expect((await fs.stat(path.join(dir, 'session.json'))).mode & 0o777).toBe(0o600);
  expect(await readStateFile(dir, 'join.json')).toBeNull();
  expect(await client.join('another', 'Other')).toEqual({ state: 'connected', channelName: 'Release room' });
});
it('filters own sender, other rooms and events; dedups and appends in order with labels', async () => {
  await connected();
  handler!(message('$own', credentials.userId));
  handler!({ ...message('$other'), roomId: '!other:s' });
  handler!({ ...message('$event'), type: 'com.khala.event.v1' });
  handler!(message('$1')); handler!(message('$1')); handler!(message('$2', '@khala_xyz:s')); handler!(message('$3'));
  const inbox = await entries();
  expect(inbox.map(m => m.eventId)).toEqual(['$1', '$2', '$3']);
  expect(inbox.map(m => m.senderLabel)).toEqual(['Maya', 'khala_xyz', 'Maya']);
  expect(waker).toHaveBeenCalledTimes(3);
  expect((await client.status()).unread).toBe(3);
});
it('buffers messages racing join and contains callback errors', async () => {
  const joining = deferred<void>(); vi.mocked(session.join).mockReturnValue(joining.promise);
  waker.mockImplementation(() => { throw new Error('waker failed'); });
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(() => expect(session.join).toHaveBeenCalled());
  handler!(message('$early')); expect(await entries()).toEqual([]);
  joining.resolve();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
  expect((await entries()).map(m => m.eventId)).toEqual(['$early']);
});
it('reads earlier and own history without appending or waking; preserves pagination and labels', async () => {
  await connected();
  vi.mocked(session.history).mockResolvedValue({ messages: [message('$old'), message('$own', credentials.userId), { ...message('$event'), type: 'com.khala.event.v1' }], nextBefore: '$old' });
  const page = await client.read(2, '$before');
  expect(page.messages.map(m => m.eventId)).toEqual(['$old', '$own']);
  expect(page.messages[0]?.senderLabel).toBe('Maya'); expect(page.nextBefore).toBe('$old');
  expect(session.history).toHaveBeenCalledWith(credentials.roomId, 2, '$before');
  expect(await entries()).toEqual([]); expect(waker).not.toHaveBeenCalled();
  vi.mocked(session.history).mockResolvedValue({ messages: [] });
  expect(await client.read(2)).toEqual({ messages: [] });
});
it('guards read/send and recovers from sanitized send failures', async () => {
  await expect(client.send('x')).rejects.toMatchObject({ code: 'not_connected' });
  await expect(client.read(1)).rejects.toMatchObject({ code: 'not_connected' });
  await connected();
  vi.mocked(session.send).mockRejectedValueOnce(new Error('SECRET'));
  await expect(client.send('x')).rejects.toMatchObject({ code: 'send_failed', message: 'send_failed' });
  expect(await statusFile()).toEqual({ state: 'send_failed', detail: 'send_failed', channelName: 'Release room', updatedAt: now().toISOString() });
  expect(await client.send('x')).toEqual({ eventId: '$sent' }); expect((await statusFile())?.state).toBe('connected');
});
it.each([new KhalaClientError('invalid_link'), new KhalaClientError('internal_error', 'rate_limited'), new Error('SECRET')])('sanitizes request failure %s', async error => {
  joinApi.requestJoin.mockRejectedValue(error);
  const expected = error instanceof KhalaClientError ? error : new KhalaClientError('internal_error');
  await expect(client.join(link, 'Codex')).rejects.toMatchObject({ code: expected.code, message: expected.message });
  expect((await statusFile())?.detail).toBe(expected.message);
});
it('handles poll expiry and expired persisted joins with an explicit retry', async () => {
  await client.join(link, 'Codex'); poll.reject(new KhalaClientError('join_expired', 'expired'));
  await vi.waitFor(async () => expect((await statusFile())?.detail).toBe('join_expired'));
  expect((await client.status()).state).toBe('idle');
  await writeStateFile(dir, 'join.json', { ...created, link, expiresAt: '2020-01-01T00:00:00Z' });
  await expect(client.join(link, 'Codex')).rejects.toMatchObject({ code: 'join_expired' });
  poll = deferred<AgentCredentials>();
  await client.join(link, 'Codex'); expect(joinApi.requestJoin).toHaveBeenCalledTimes(2);
});
it('cleans up invite timeout and contains raw session errors', async () => {
  vi.mocked(session.waitForInvite).mockRejectedValue(new Error('invite_timeout'));
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(async () => expect((await statusFile())?.detail).toBe('invite_timeout'));
  expect((await client.status()).state).toBe('disconnected');
  expect(session.stop).toHaveBeenCalledTimes(1); expect(await readStateFile(dir, 'session.json')).toBeNull();
});
it('closes idempotently and cannot be revived by late credentials', async () => {
  await client.join(link, 'Codex');
  await Promise.all([client.close(), client.close()]);
  poll.resolve(credentials); await Promise.resolve();
  expect(startSession).not.toHaveBeenCalled(); expect(await readStateFile(dir, 'session.json')).toBeNull();
  expect(await statusFile()).toEqual({ state: 'disconnected', detail: 'closed', updatedAt: now().toISOString() });
  await expect(client.join(link, 'Codex')).rejects.toMatchObject({ code: 'not_connected' });
});
it('stops a connected session once on close', async () => {
  await connected(); await client.close(); await client.close();
  expect(session.stop).toHaveBeenCalledTimes(1); expect(await readStateFile(dir, 'session.json')).toBeNull();
  expect((await statusFile())?.channelName).toBe('Release room');
});
it('never reuses stale credentials or saved confirmation on process start', async () => {
  await ensureStateDir(dir); await writeStateFile(dir, 'session.json', credentials);
  await writeStateFile(dir, 'join.json', { ...created, link });
  expect(await client.status()).toEqual({ state: 'idle', unread: 0 });
  expect(await readStateFile(dir, 'session.json')).toBeNull();
  await client.join(link, 'Codex'); expect(joinApi.requestJoin).toHaveBeenCalledTimes(1); expect(startSession).not.toHaveBeenCalled();
});
it('counts all unread kinds', async () => {
  await connected(); await appendInbox(dir, toInboxEntry(message('$message')));
  await appendInbox(dir, { ...toInboxEntry(message('$event')), kind: 'event' });
  expect((await client.status()).unread).toBe(2);
});
it('replaces a pending link without stale failure overwriting the new attempt', async () => {
  await client.join(link, 'Codex'); const oldPoll = poll;
  poll = deferred<AgentCredentials>();
  await client.join('https://khala.example/join/ijklmnop', 'Codex');
  expect(joinApi.pollJoin.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  oldPoll.reject(new KhalaClientError('join_expired')); poll.resolve(credentials);
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
});
it('stops a session that finishes starting after close without reviving state', async () => {
  const starting = deferred<AgentMatrixSession>(); startSession.mockReturnValue(starting.promise);
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(() => expect(startSession).toHaveBeenCalled());
  await client.close(); starting.resolve(session);
  await vi.waitFor(() => expect(session.stop).toHaveBeenCalledTimes(1));
  expect(joinApi.reportReady).not.toHaveBeenCalled();
  expect(await readStateFile(dir, 'session.json')).toBeNull(); expect((await statusFile())?.detail).toBe('closed');
});
it('contains a session startup error without leaking its token', async () => {
  startSession.mockRejectedValue(new Error('SECRET'));
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(async () => expect((await statusFile())?.state).toBe('disconnected'));
  expect((await statusFile())?.detail).toBe('internal_error'); expect(await readStateFile(dir, 'session.json')).toBeNull();
});
it('falls back to the room id and propagates injected fetch and invite timeout', async () => {
  const fakeFetch = vi.fn<typeof fetch>();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now,
    startSession, joinApi, fetch: fakeFetch, inviteTimeoutMs: 321 });
  vi.mocked(session.roomName).mockReturnValue(undefined);
  await connected();
  expect((await client.status()).channelName).toBe(credentials.roomId);
  expect(joinApi.requestJoin).toHaveBeenCalledWith({ link, harness: 'codex', label: 'Codex' }, { fetch: fakeFetch });
  expect(joinApi.pollJoin.mock.calls[0]![1]?.fetch).toBe(fakeFetch);
  expect(joinApi.reportReady.mock.calls[0]![1]?.fetch).toBe(fakeFetch);
  expect(session.waitForInvite).toHaveBeenCalledWith(credentials.roomId, 321);
});

const channelEvent = (id: string, sender = '@khala_abc:s', key: string | undefined = 'key'): SessionMessage => ({
  ...message(id, sender), type: 'com.khala.event.v1', content: { v: 1, kind: 'ci.failed', summary: 'CI failed: test', body: 'fallback', ...(key !== undefined ? { key } : {}) },
});
it('dedupes keys across senders and drops own and malformed events before key consumption', async () => {
  await connected();
  handler!(channelEvent('$own', credentials.userId));
  handler!({ ...channelEvent('$bad'), content: {} });
  handler!(channelEvent('$first'));
  handler!(channelEvent('$duplicate', '@agent-other:s'));
  expect(await entries()).toEqual([{ ...toInboxEntry(message('$first'), 'Maya'), kind: 'event', body: 'CI failed: test' }]);
  expect(waker).not.toHaveBeenCalled();
});
it('preserves message/event order and wakes only for messages', async () => {
  await connected();
  handler!(message('$1')); handler!(channelEvent('$2')); handler!(message('$3'));
  expect((await entries()).map(entry => [entry.eventId, entry.kind])).toEqual([['$1', 'message'], ['$2', 'event'], ['$3', 'message']]);
  expect(waker.mock.calls.map(([entry]) => entry.eventId)).toEqual(['$1', '$3']);
  expect((await client.status()).unread).toBe(3);
});
it('reads own events, skips invalid and duplicate keys per page, and keeps intake dedupe separate', async () => {
  await connected();
  handler!(channelEvent('$live')); await entries();
  const own = channelEvent('$own', credentials.userId);
  vi.mocked(session.history).mockResolvedValue({ messages: [message('$1'), own, channelEvent('$dup'), { ...channelEvent('$bad'), content: {} }, { ...channelEvent('$unkeyed1'), content: { v: 1, kind: 'custom', summary: 'unkeyed', body: '' } }, { ...channelEvent('$unkeyed2'), content: { v: 1, kind: 'custom', summary: 'unkeyed', body: '' } }], nextBefore: '$1' });
  for (let i = 0; i < 2; i++) {
    const page = await client.read(10);
    expect(page.messages.map(entry => entry.eventId)).toEqual(['$1', '$own', '$unkeyed1', '$unkeyed2']);
    expect(page.messages[1]).toMatchObject({ kind: 'event', sender: credentials.userId, body: 'CI failed: test' });
    expect(page.nextBefore).toBe('$1');
  }
  expect((await entries()).map(entry => entry.eventId)).toEqual(['$live']);
  expect(waker).not.toHaveBeenCalled();
});
