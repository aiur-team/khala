import ready from '../../contracts/fixtures/aiur-events/pr-ready-for-review.json';
import { createKhalaTools } from './mcp/tools';
import { createHash } from 'node:crypto';
import { encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { StartSession } from './transport';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { requestJoin, pollJoin, reportReady } from './join';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { KhalaAgentClient } from './client';
import { KhalaClientError } from './client';
import { createKhalaAgentClient } from './client-impl';
import type { AgentMatrixSession, SessionModeCommand, SessionMessage } from './matrix/session';
import { appendInbox } from './inbox';
import { ensureStateDir, readStateFile, resolveStateDir, writeStateFile } from './state';
import { toInboxEntry } from './sender';
import { deliver } from '../hooks/deliver';

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
let modeHandler: ((command: SessionModeCommand) => void) | undefined;
let session: AgentMatrixSession;
let joinApi: { requestJoin: Mock<typeof requestJoin>; pollJoin: Mock<typeof pollJoin>; reportReady: Mock<typeof reportReady> };
let waker: Mock<(entry: InboxEntry) => void>;
let startSession: Mock<StartSession>;
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
  modeHandler = undefined;
  session = {
    userId: credentials.userId,
    inviter: vi.fn(() => '@owner:s'),
    onListeningModeCommand: vi.fn(callback => { modeHandler = callback; return () => { modeHandler = undefined; }; }),
    publishListeningMode: vi.fn(async () => {}),
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
  expect(await client.status()).toEqual({ state: 'connected', channelName: 'Release room', agentUserId: credentials.userId, unread: 0, listeningMode: 'sync' });
  const calls = [joinApi.pollJoin, startSession, session.onMessage, joinApi.reportReady, session.waitForInvite, session.join].map(fn => vi.mocked(fn).mock.invocationCallOrder[0]!);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));
  expect(session.waitForInvite).toHaveBeenCalledWith(credentials.roomId, 120_000);
  expect(await readStateFile(dir, 'session.json')).toEqual(credentials);
  expect((await fs.stat(path.join(dir, 'session.json'))).mode & 0o777).toBe(0o600);
  expect(await readStateFile(dir, 'join.json')).toBeNull();
  expect(await client.join(link, 'Other')).toEqual({ state: 'connected', channelName: 'Release room' });
  expect(joinApi.requestJoin).toHaveBeenCalledTimes(1);
  expect(session.stop).not.toHaveBeenCalled();
});
it('leaves the connected channel and clears delivery state when joining a different link', async () => {
  await connected();
  handler!(message('$old'));
  handler!(channelEvent('$old-event'));
  await entries();
  await writeStateFile(dir, 'cursor.json', { lastDeliveredEventId: '$old', deliveredCount: 1 });
  const oldHandler = handler!;
  const nextLink = 'https://khala.example/join/ijklmnop';
  const nextCreated = { ...created, joinId: 'next', confirmUrl: 'https://khala.example/agent/confirm/next' };
  joinApi.requestJoin.mockResolvedValueOnce(nextCreated);
  poll = deferred<AgentCredentials>();

  expect(await client.join(nextLink, 'Other')).toEqual({ state: 'awaiting_confirmation', confirmUrl: nextCreated.confirmUrl });
  expect(joinApi.requestJoin).toHaveBeenCalledTimes(2);
  expect(joinApi.requestJoin).toHaveBeenLastCalledWith({ link: nextLink, harness: 'codex', label: 'Other', sessionId: 'test', rejoinSecret: expect.any(String) }, {});
  expect(session.stop).toHaveBeenCalledTimes(1);
  expect(joinApi.pollJoin.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(await readStateFile(dir, 'session.json')).toBeNull();
  await expect(fs.stat(path.join(dir, 'inbox.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(dir, 'cursor.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await client.status()).toEqual({ state: 'joining', unread: 0, listeningMode: 'sync' });
  oldHandler(message('$stale'));
  expect(await entries()).toEqual([]);

  vi.mocked(session.roomName).mockReturnValue('Next room');
  poll.resolve(credentials);
  await vi.waitFor(async () => expect((await client.status()).channelName).toBe('Next room'));
  handler!(channelEvent('$next-event'));
  handler!(message('$next'));
  expect((await entries()).map(entry => entry.eventId)).toEqual(['$next-event', '$next']);
  expect((await client.status()).unread).toBe(2);
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
  expect(await client.status()).toEqual({ state: 'idle', unread: 0, listeningMode: 'sync' });
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
  const nextLink = 'https://khala.example/join/ijklmnop';
  const nextCreated = { ...created, confirmUrl: 'https://khala.example/agent/confirm/next' };
  joinApi.requestJoin.mockResolvedValueOnce(nextCreated);
  expect(await client.join(nextLink, 'Codex')).toEqual({ state: 'awaiting_confirmation', confirmUrl: nextCreated.confirmUrl });
  expect(joinApi.requestJoin).toHaveBeenCalledTimes(2);
  expect(joinApi.requestJoin).toHaveBeenLastCalledWith({ link: nextLink, harness: 'codex', label: 'Codex', sessionId: 'test', rejoinSecret: expect.any(String) }, {});
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
  expect(joinApi.requestJoin).toHaveBeenCalledWith({ link, harness: 'codex', label: 'Codex', sessionId: 'test', rejoinSecret: expect.any(String) }, { fetch: fakeFetch });
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
  handler!({ ...channelEvent('$bad'), content: { ...channelEvent('$bad').content, url: 'javascript:x' } });
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

it('buffers events racing join and dedupes without waking after join', async () => {
  const joining = deferred<void>(); vi.mocked(session.join).mockReturnValue(joining.promise);
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(() => expect(session.join).toHaveBeenCalled());
  handler!(channelEvent('$early')); handler!(channelEvent('$duplicate', '@agent-other:s'));
  expect(await entries()).toEqual([]);
  joining.resolve();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
  expect((await entries()).map(entry => [entry.eventId, entry.kind])).toEqual([['$early', 'event']]);
  expect(waker).not.toHaveBeenCalled();
});

function outgoingEvent(key?: string) {
  const encoded = encodeChannelEvent({ kind: 'ci.passed', summary: 'CI passed', ...(key === undefined ? {} : { key }) });
  if (!encoded.ok) throw new Error('invalid fixture');
  return encoded.value;
}
it('uses stable key-derived transaction ids and leaves unkeyed ids to the SDK', async () => {
  await connected();
  const content = outgoingEvent('retry-key');
  expect(await client.sendChannelEvent(content)).toEqual({ eventId: '$event' });
  await client.sendChannelEvent(content);
  await client.sendChannelEvent(outgoingEvent('another-key'));
  await client.sendChannelEvent(outgoingEvent());
  const calls = vi.mocked(session.sendChannelEvent).mock.calls;
  const expected = 'khev-' + createHash('sha256').update('retry-key').digest('hex').slice(0, 32);
  expect(calls[0]).toEqual([credentials.roomId, content, expected]);
  expect(calls[1]?.[2]).toBe(expected);
  expect(calls[2]?.[2]).toMatch(/^khev-[0-9a-f]{32}$/);
  expect(calls[2]?.[2]).not.toBe(expected);
  expect(calls[3]?.[2]).toBeUndefined();
  expect(waker).not.toHaveBeenCalled();
});
it('guards event sends and restores connected status after retry', async () => {
  const content = outgoingEvent();
  await expect(client.sendChannelEvent(content)).rejects.toMatchObject({ code: 'not_connected' });
  expect(session.sendChannelEvent).not.toHaveBeenCalled();
  await connected();
  vi.mocked(session.sendChannelEvent).mockRejectedValueOnce(new Error('SECRET'));
  await expect(client.sendChannelEvent(content)).rejects.toMatchObject({ code: 'send_failed', message: 'send_failed' });
  expect(await statusFile()).toEqual({ state: 'send_failed', detail: 'send_failed', channelName: 'Release room', updatedAt: now().toISOString() });
  expect(await client.sendChannelEvent(content)).toEqual({ eventId: '$event' });
  expect((await statusFile())?.state).toBe('connected');
});
it('revalidates and canonicalizes content before reaching the session', async () => {
  await connected();
  await expect(client.sendChannelEvent({ ...outgoingEvent(), url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'internal_error', message: 'invalid_event' });
  expect(session.sendChannelEvent).not.toHaveBeenCalled();
  expect((await statusFile())?.state).toBe('connected');
  await client.sendChannelEvent({ ...outgoingEvent(), body: 'raw body' });
  expect(session.sendChannelEvent).toHaveBeenCalledWith(credentials.roomId, outgoingEvent(), undefined);
});

it('routes a real Aiur fixture from the tool through the client to the joined session', async () => {
  await connected();
  const tool = createKhalaTools({ harness: 'codex', clientFor: () => client }).find(tool => tool.name === 'khala_event')!;
  const response = await tool.call({ aiur: ready, ticketPrefix: 'AIUR-' }, { id: 1, notification: false, meta: undefined });
  expect(response.result).toMatchObject({ structuredContent: { eventId: '$event' }, content: [{ type: 'text', text: 'Posted channel event: AIUR-395 review requested · feat/events-cursor' }] });
  expect(session.sendChannelEvent).toHaveBeenCalledExactlyOnceWith(credentials.roomId,
    expect.objectContaining({ v: 1, body: 'AIUR-395 review requested · feat/events-cursor', key: 'pr:aiur-team/aiur:ready_for_review:412:3f9c2ab0d1' }),
    'khev-' + createHash('sha256').update('pr:aiur-team/aiur:ready_for_review:412:3f9c2ab0d1').digest('hex').slice(0, 32));
  expect(waker).not.toHaveBeenCalled();
});

const modeCommand = (content: unknown = { v: 1, agent: credentials.userId, mode: 'async' }, sender = '@owner:s'): SessionModeCommand => ({ eventId: '$mode', roomId: credentials.roomId, sender, ts: now().getTime(), content });
it('applies owner commands, echoes member state and keeps commands out of the inbox', async () => {
  await connected(); modeHandler!(modeCommand());
  expect((await client.status()).listeningMode).toBe('async');
  expect(await readStateFile(dir, 'mode.json')).toEqual({ mode: 'async', changedBy: 'owner', eventId: '$mode', updatedAt: now().toISOString() });
  expect(session.publishListeningMode).toHaveBeenCalledWith(credentials.roomId, 'async', expect.any(AbortSignal));
  expect(await entries()).toEqual([]); expect(waker).not.toHaveBeenCalled();
});
it.each([
  modeCommand(undefined, '@other:s'),
  modeCommand({ v: 1, agent: '@other-agent:s', mode: 'async' }),
  modeCommand({ v: 1, agent: credentials.userId, mode: 'loud' }),
  modeCommand({ v: 1, agent: credentials.userId, mode: 'async', extra: true }),
  { ...modeCommand(), roomId: '!other:s' },
])('ignores unauthorized or malformed mode command %j', async command => {
  await connected(); modeHandler!(command); await client.status();
  expect(await readStateFile(dir, 'mode.json')).toBeNull();
  expect(session.publishListeningMode).not.toHaveBeenCalled(); expect(await entries()).toEqual([]);
});
it('ignores all commands without an inviter', async () => {
  vi.mocked(session.inviter).mockReturnValue(undefined); await connected(); modeHandler!(modeCommand());
  expect((await client.status()).listeningMode).toBe('sync'); expect(session.publishListeningMode).not.toHaveBeenCalled();
});
it('keeps local mode and connected status when member publishing fails', async () => {
  vi.mocked(session.publishListeningMode).mockRejectedValue(new Error('publish failed'));
  await connected(); modeHandler!(modeCommand());
  expect(await client.status()).toMatchObject({ state: 'connected', listeningMode: 'async' });
});
it('buffers commands delivered during join until inviter capture is complete', async () => {
  vi.mocked(session.join).mockImplementation(async () => { modeHandler!(modeCommand()); });
  await connected(); expect((await client.status()).listeningMode).toBe('async');
});
it('starts a fresh membership in sync', async () => {
  await connected(); modeHandler!(modeCommand()); await client.status();
  await client.join('https://khala.example/join/ijklmnop', 'Codex');
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
  expect((await client.status()).listeningMode).toBe('sync');
});

it('preserves message and command arrival order while joining', async () => {
  vi.mocked(session.join).mockImplementation(async () => {
    modeHandler!(modeCommand()); handler!(message('$before'));
    modeHandler!(modeCommand({ v: 1, agent: credentials.userId, mode: 'sync' }));
    handler!(message('$after'));
  });
  await connected(); expect(await client.status()).toMatchObject({ listeningMode: 'sync', unread: 1 });
  expect((await entries()).map(e => e.eventId)).toEqual(['$before', '$after']);
});

it('releases stalled member echoes after the deadline so intake and status continue', async () => {
  await connected();
  const publishing = deferred<void>();
  vi.mocked(session.publishListeningMode).mockImplementation(() => { publishing.resolve(); return new Promise(() => {}); });
  vi.useFakeTimers();
  try {
    modeHandler!(modeCommand());
    await publishing.promise;
    handler!(message('$after-mode'));
    let finished = false;
    const status = client.status().then(value => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(4999); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await status).toMatchObject({ state: 'connected', listeningMode: 'async', unread: 1 });
    expect(vi.mocked(session.publishListeningMode).mock.calls[0]![2]?.aborted).toBe(true);
    await client.close();
  } finally { vi.useRealTimers(); }
});
it('cancels a stalled member echo when closing without waiting for its deadline', async () => {
  await connected();
  vi.mocked(session.publishListeningMode).mockImplementation(() => new Promise(() => {}));
  modeHandler!(modeCommand());
  await vi.waitFor(() => expect(session.publishListeningMode).toHaveBeenCalledOnce());
  await client.close();
  expect(vi.mocked(session.publishListeningMode).mock.calls[0]![2]?.aborted).toBe(true);
});

it('waits for auto-confirmed handshake and preserves local credentials', async () => {
  joinApi.requestJoin.mockResolvedValueOnce({ ...created, autoConfirmed: true });
  poll.resolve({ ...credentials, transport: 'local' });
  expect(await client.join(link, 'Codex')).toEqual({ state: 'connected', channelName: 'Release room' });
  expect((await client.status()).state).toBe('connected');
  const calls = [joinApi.pollJoin, startSession, session.onMessage, joinApi.reportReady, session.waitForInvite, session.join].map(fn => vi.mocked(fn).mock.invocationCallOrder[0]!);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));
  expect(await readStateFile(dir, 'session.json')).toEqual({ ...credentials, transport: 'local' });
});
it('returns an auto-confirmed fallback, coalesces pending joins and connects later', async () => {
  await client.close();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi, autoConfirmWaitMs: 50 });
  const invite = deferred<void>();
  vi.mocked(session.waitForInvite).mockReturnValue(invite.promise);
  joinApi.requestJoin.mockResolvedValueOnce({ ...created, autoConfirmed: true });
  poll.resolve(credentials);
  const fallback = { state: 'awaiting_confirmation', confirmUrl: created.confirmUrl, autoConfirmed: true };
  expect(await client.join(link, 'Codex')).toEqual(fallback);
  expect((await client.status()).state).toBe('joining');
  expect(await client.join(link, 'Codex')).toEqual(fallback);
  invite.resolve();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
});
it('fails auto-confirmed joins promptly without exposing secrets', async () => {
  joinApi.requestJoin.mockResolvedValueOnce({ ...created, autoConfirmed: true });
  startSession.mockRejectedValueOnce(new Error('SECRET POLL'));
  poll.resolve(credentials);
  const error = await client.join(link, 'Codex').catch(error => error);
  expect(error).toBeInstanceOf(KhalaClientError);
  expect(error.code).toBe('internal_error');
  expect(String(error)).not.toMatch(/SECRET|POLL/);
  expect((await client.status()).state).toBe('disconnected');
});
it('preserves expiry status when an auto-confirmed attempt expires', async () => {
  joinApi.requestJoin.mockResolvedValueOnce({ ...created, autoConfirmed: true });
  joinApi.pollJoin.mockRejectedValueOnce(new KhalaClientError('join_expired', 'expired'));
  await expect(client.join(link, 'Codex')).rejects.toMatchObject({ code: 'join_expired' });
  expect(await statusFile()).toMatchObject({ state: 'idle', detail: 'join_expired' });
});
it('closes during an auto-confirm wait without retaining timers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    joinApi.requestJoin.mockResolvedValueOnce({ ...created, autoConfirmed: true });
    const pending = client.join(link, 'Codex');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'not_connected' });
    // Wait for real filesystem work without advancing the auto-confirm deadline.
    while (vi.getTimerCount() === 0) await new Promise<void>(resolve => setImmediate(resolve));
    expect(vi.getTimerCount()).toBe(1);
    await client.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('keeps the hosted immediate return shape unchanged', async () => {
  const result = await client.join(link, 'Codex');
  expect(result).toEqual({ state: 'awaiting_confirmation', confirmUrl: created.confirmUrl });
  expect(Object.keys(result)).toEqual(['state', 'confirmUrl']);
  expect(startSession).not.toHaveBeenCalled();
});
it('caches the own hosted default username after connecting', async () => {
  vi.mocked(session.displayName).mockImplementation(id => id === credentials.userId ? 'kevin-Codex' : 'other-Claude');
  await connected();
  await client.status();
  expect(JSON.parse(await fs.readFile(path.join(root, 'khala', 'hosted-profile.json'), 'utf8'))).toMatchObject({ v: 1, username: 'kevin' });
});
it('does not cache a renamed hosted agent', async () => {
  vi.mocked(session.displayName).mockReturnValue('reviewer');
  await connected();
  await client.status();
  await expect(fs.stat(path.join(root, 'khala', 'hosted-profile.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not cache a local transport username', async () => {
  vi.mocked(session.displayName).mockReturnValue('kevin-Codex');
  await client.join(link, 'Codex');
  poll.resolve({ ...credentials, transport: 'local' });
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
  await client.status();
  await expect(fs.stat(path.join(root, 'khala', 'hosted-profile.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('contains hosted cache write failure through status and close', async () => {
  await fs.mkdir(path.join(root, 'khala', 'hosted-profile.json'), { recursive: true, mode: 0o700 });
  vi.mocked(session.displayName).mockReturnValue('kevin-Codex');
  await connected();
  expect((await client.status()).state).toBe('connected');
  await expect(client.close()).resolves.toBeUndefined();
});

it('restores the listening mode from the joined member rather than stale process state', async () => {
  session.listeningMode = () => 'async';
  await connected();
  expect((await client.status()).listeningMode).toBe('async');
  expect(await readStateFile(dir, 'mode.json')).toEqual({ mode: 'async' });
});

it('replaces a rejoin.json that parses but holds an invalid secret instead of failing every start', async () => {
  await ensureStateDir(dir);
  await writeStateFile(dir, 'rejoin.json', { secret: 'not-a-secret' });
  await client.join(link, 'Codex');
  const secret = (await readStateFile<{ secret: string }>(dir, 'rejoin.json'))!.secret;
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await fs.stat(path.join(dir, 'rejoin.json'))).mode & 0o777).toBe(0o600);
  expect(joinApi.requestJoin).toHaveBeenCalledWith({ link, harness: 'codex', label: 'Codex', sessionId: 'test', rejoinSecret: secret }, {});
  expect((await client.status()).state).not.toBe('error');
  await client.close();
  const restarted = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  try {
    await restarted.join(link, 'Codex');
    expect(joinApi.requestJoin).toHaveBeenLastCalledWith(expect.objectContaining({ rejoinSecret: secret }), {});
  } finally { await restarted.close(); }
});

it('never sends a rejoin identity for Cursor windows that share cursor-default on one machine (hosted)', async () => {
  // Hosted twin of the real-helper regression in local/serve.test.ts: both windows share one
  // state dir, so a shared secret would make the control plane give them one Matrix identity.
  const env = { XDG_STATE_HOME: root };
  const windows = [0, 1].map(() => createKhalaAgentClient({ harness: 'cursor', sessionId: 'cursor-default', env, now, startSession, joinApi }));
  try {
    for (const window of windows) await window.join(link, 'Cursor');
    expect(joinApi.requestJoin.mock.calls.map(call => call[0])).toEqual([
      { link, harness: 'cursor', label: 'Cursor' }, { link, harness: 'cursor', label: 'Cursor' },
    ]);
    expect(await readStateFile(resolveStateDir('cursor', 'cursor-default', env), 'rejoin.json')).toBeNull();
  } finally { await Promise.all(windows.map(window => window.close())); }
});

it('delivers member renames once, including self changes, without waking on events', async () => {
  await connected();
  const renamed: SessionMessage = { ...message('$rename', credentials.userId), type: 'm.room.member',
    content: { membership: 'join', displayname: 'reviewer' }, previousContent: { membership: 'join', displayname: 'kevin-Codex' } };
  handler!(renamed); handler!(renamed);
  handler!({ ...renamed, eventId: '$mode', previousContent: renamed.content });
  expect(await entries()).toEqual([expect.objectContaining({ eventId: '$rename', kind: 'event', body: 'kevin-Codex is now reviewer' })]);
  expect(waker).not.toHaveBeenCalled();
  vi.mocked(session.history).mockResolvedValue({ messages: [renamed] });
  expect((await client.read(30)).messages).toEqual(await entries());
});

it('reports the current own display name and drops it after disconnecting', async () => {
  await connected();
  vi.mocked(session.displayName).mockImplementation(user => user === credentials.userId ? 'reviewer' : undefined);
  expect(await client.status()).toMatchObject({ displayName: 'reviewer' });
  vi.mocked(session.displayName).mockReturnValue('kev-Codex');
  expect(await client.status()).toMatchObject({ displayName: 'kev-Codex' });
  await client.close();
  expect(await client.status()).not.toHaveProperty('displayName');
});

it('tells delivery frames and khala_read who "you" are, and follows a rename (#1089)', async () => {
  let own = 'kev-Codex';
  vi.mocked(session.displayName).mockImplementation(user => user === credentials.userId ? own : user === '@khala_abc:s' ? 'Maya' : undefined);
  await connected();
  expect(await statusFile()).toMatchObject({ state: 'connected', displayName: 'kev-Codex' });
  async function frame(): Promise<string> {
    let out = '';
    await deliver(JSON.stringify({ session_id: 'test', hook_event_name: 'UserPromptSubmit' }), ['--harness', 'codex'],
      { stdout: { write: (text: string) => { out += text; } }, stderr: { write: () => {} }, env: { XDG_STATE_HOME: root }, now });
    return JSON.parse(out).hookSpecificOutput.additionalContext;
  }
  handler!(message('$hello'));
  await vi.waitFor(async () => expect(await entries()).toHaveLength(1));
  const first = await frame();
  expect(first).toContain('<khala-channel-messages channel="Release room" you="kev-Codex" count="1">');
  expect(first).toContain('\nYou are kev-Codex in this channel; messages that name or @mention you are addressed to you.\n');
  expect(await client.read(5)).toMatchObject({ you: 'kev-Codex' });
  // The rename event names the new name before the session state catches up (Matrix timing).
  handler!({ ...message('$rename', credentials.userId), type: 'm.room.member',
    content: { membership: 'join', displayname: 'Scout' }, previousContent: { membership: 'join', displayname: 'kev-Codex' } });
  handler!(message('$after'));
  await vi.waitFor(async () => expect(await entries()).toHaveLength(3));
  expect(await statusFile()).toMatchObject({ displayName: 'Scout' });
  const second = await frame();
  expect(second).toContain(' you="Scout" ');
  expect(second).toContain('You are Scout in this channel;');
  expect(second).toContain('kev-Codex is now Scout');
  own = 'Scout';
  expect(await client.read(5)).toMatchObject({ you: 'Scout' });
  expect(await client.status()).toMatchObject({ displayName: 'Scout' });
});

it('another member cannot set my you= name via content.user (hosted)', async () => {
  vi.mocked(session.displayName).mockImplementation(user => user === credentials.userId ? 'kev-Codex' : user === '@khala_abc:s' ? 'Maya' : undefined);
  await connected();
  handler!({ ...message('$spoof', '@khala_abc:s'), type: 'm.room.member',
    content: { membership: 'join', displayname: 'Maya', user: credentials.userId }, previousContent: { membership: 'join', displayname: 'Mayb' } });
  handler!(message('$after'));
  await vi.waitFor(async () => expect((await entries()).length).toBeGreaterThanOrEqual(2));
  expect(await statusFile()).toMatchObject({ displayName: 'kev-Codex' });
});

it('a local owner-authored rename cascade still updates you=', async () => {
  vi.mocked(session.displayName).mockImplementation(user => user === credentials.userId ? 'kev-Codex' : user === '@khala_abc:s' ? 'Maya' : undefined);
  await client.join(link, 'Codex');
  poll.resolve({ ...credentials, transport: 'local' });
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
  // A local non-owner cannot use content.user either.
  handler!({ ...message('$spoof', '@khala_abc:s'), type: 'm.room.member',
    content: { membership: 'join', displayname: 'Maya', user: credentials.userId }, previousContent: { membership: 'join', displayname: 'Mayb' } });
  handler!(message('$mid'));
  await vi.waitFor(async () => expect((await entries()).length).toBeGreaterThanOrEqual(2));
  expect(await statusFile()).toMatchObject({ displayName: 'kev-Codex' });
  handler!({ ...message('$cascade', '@khala_owner:local'), type: 'm.room.member',
    content: { membership: 'join', displayname: 'kevin-Codex', user: credentials.userId }, previousContent: { membership: 'join', displayname: 'kev-Codex' } });
  await vi.waitFor(async () => expect(await statusFile()).toMatchObject({ displayName: 'kevin-Codex' }));
  let out = '';
  await deliver(JSON.stringify({ session_id: 'test', hook_event_name: 'UserPromptSubmit' }), ['--harness', 'codex'],
    { stdout: { write: (text: string) => { out += text; } }, stderr: { write: () => {} }, env: { XDG_STATE_HOME: root }, now });
  expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(' you="kevin-Codex" ');
});

it('reports a removed hosted session as disconnected and rejects subsequent sends', async () => {
  let ended!: (reason: 'removed') => void;
  session.onEnded = vi.fn(callback => { ended = callback; return () => {}; });
  await connected(); ended('removed');
  await vi.waitFor(async () => expect(await client.status()).toMatchObject({ state: 'disconnected', detail: 'removed' }));
  await expect(client.send('after removal')).rejects.toMatchObject({ code: 'not_connected' });
  await expect(client.sendChannelEvent({ v: 1, kind: 'test', summary: 'after removal', body: 'after removal' })).rejects.toMatchObject({ code: 'not_connected' });
  expect(session.send).not.toHaveBeenCalled(); expect(session.sendChannelEvent).not.toHaveBeenCalled();
});


it.each([200, 404])('provides an authenticated removal probe and ignores unavailable status (%s)', async responseStatus => {
  const fetchStatus = vi.fn(async () => new Response(JSON.stringify({ removed: true }), { status: responseStatus }));
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi, fetch: fetchStatus });
  await connected();
  const checkRemoved = startSession.mock.calls[0]![1]!.checkRemoved!;
  expect(await checkRemoved()).toBe(responseStatus === 200);
  const expectedUrl = new URL('https://khala.example/api/agent/session/status');
  expectedUrl.searchParams.set('userId', credentials.userId);
  expectedUrl.searchParams.set('roomId', credentials.roomId);
  expect(fetchStatus).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ headers: { authorization: 'Bearer SECRET' }, signal: expect.any(AbortSignal) }));
});

it('returns not_connected when authoritative removal ends a failed send', async () => {
  let ended!: (reason: 'removed') => void;
  session.onEnded = vi.fn(callback => { ended = callback; return () => {}; });
  await connected();
  vi.mocked(session.send).mockImplementation(async () => { ended('removed'); throw new Error('forbidden'); });
  await expect(client.send('hello')).rejects.toMatchObject({ code: 'not_connected' });
  await vi.waitFor(async () => expect(await client.status()).toMatchObject({ state: 'disconnected', detail: 'removed' }));
});


it.each([['codex', 'matrix'], ['claude', 'matrix'], ['codex', 'local'], ['claude', 'local']] as const)('restores %s %s transport and wake intake after close without another join', async (harness, transport) => {
  if (harness === 'claude') {
    await client.close();
    dir = resolveStateDir(harness, 'test', { XDG_STATE_HOME: root });
    client = createKhalaAgentClient({ harness, sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  }
  const original = transport === 'local' ? { ...credentials, transport: 'local' as const } : credentials;
  poll.resolve(original);
  await connected();
  await client.close();
  expect(await readStateFile(dir, 'session.json')).toBeNull();
  expect((await fs.stat(path.join(dir, 'resume.json'))).mode & 0o777).toBe(0o600);
  joinApi.requestJoin.mockClear();
  joinApi.pollJoin.mockClear();
  joinApi.reportReady.mockClear();
  const refreshed = { ...credentials, deviceId: 'fresh-device', accessToken: 'REFRESHED' };
  const fetch = vi.fn(async () => Response.json(refreshed));
  client = createKhalaAgentClient({ harness, sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi, fetch, onInboxAppend: waker });
  await client.resume!();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
  expect(joinApi.requestJoin).not.toHaveBeenCalled();
  expect(joinApi.pollJoin).not.toHaveBeenCalled();
  expect(joinApi.reportReady).not.toHaveBeenCalled();
  expect(startSession).toHaveBeenLastCalledWith(transport === 'local' ? original : refreshed, expect.any(Object));
  if (transport === 'local') expect(fetch).not.toHaveBeenCalled();
  else expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL('/api/agent/session/resume', created.origin), expect.objectContaining({ method: 'POST', headers: { authorization: `Bearer ${credentials.accessToken}` } }));
  handler!(message('$resumed'));
  await vi.waitFor(() => expect(waker).toHaveBeenCalledOnce());
});

it.each(['missing', 'invalid', 'changed', 'workspace', 'left', 'removed', 'revoked', 'unauthorized', 'channel_deleted'])(
  'does not restore authorization after %s', async reason => {
    await connected();
    await client.close();
    if (reason === 'missing') await fs.unlink(path.join(dir, 'rejoin.json'));
    if (reason === 'invalid' || reason === 'changed') await writeStateFile(dir, 'rejoin.json', { secret: reason === 'invalid' ? 'bad' : 'X'.repeat(43) });
    if (reason === 'workspace') {
      const saved = (await readStateFile<Record<string, unknown>>(dir, 'resume.json'))!;
      await writeStateFile(dir, 'resume.json', { ...saved, workspace: '/another-workspace' });
    }
    if (['left', 'removed', 'revoked', 'unauthorized', 'channel_deleted'].includes(reason)) await writeStateFile(dir, 'status.json', { state: 'disconnected', detail: reason });
    startSession.mockClear();
    client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
    await client.resume!();
    expect(startSession).not.toHaveBeenCalled();
    expect((await client.status()).state).toBe('idle');
  },
);

it('explicit leave clears resume authorization even after process close overwrites status', async () => {
  await connected();
  await client.leave!();
  await client.close();
  expect(await readStateFile(dir, 'resume.json')).toBeNull();
  startSession.mockClear();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  await client.resume!();
  expect(startSession).not.toHaveBeenCalled();
});

it('owner removal clears resume authorization before close', async () => {
  let ended!: (reason: 'removed') => void;
  session.onEnded = fn => { ended = fn; return () => {}; };
  await connected();
  ended('removed');
  await client.close();
  expect(await readStateFile(dir, 'resume.json')).toBeNull();
  startSession.mockClear();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  await client.resume!();
  expect(startSession).not.toHaveBeenCalled();
});


it.each([401, 403])('clears hosted resume authorization after terminal rejection %s', async code => {
  await connected(); await client.close();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi,
    fetch: vi.fn(async () => new Response('{}', { status: code })) });
  await client.resume!();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('disconnected'));
  expect(await readStateFile(dir, 'resume.json')).toBeNull();
});

it('retains authorization after temporary hosted resume failure and restores on the next process', async () => {
  await connected(); await client.close();
  const fetch = vi.fn(async () => new Response('{}', { status: 503 }));
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi, fetch });
  await client.resume!();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('disconnected'));
  expect(await readStateFile(dir, 'resume.json')).not.toBeNull();
  await client.close();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi,
    fetch: vi.fn(async () => Response.json({ ...credentials, deviceId: 'fresh', accessToken: 'NEW' })) });
  await client.resume!();
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
});


it('cancels a hosted resume whose response body stalls during shutdown', async () => {
  await connected(); await client.close();
  let responseSignal: AbortSignal | undefined;
  const bodyStarted = deferred<void>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    responseSignal = init!.signal as AbortSignal;
    return { ok: true, status: 200, json() { bodyStarted.resolve(); return new Promise(() => {}); } } as unknown as Response;
  });
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi, fetch });
  await client.resume!();
  await bodyStarted.promise;
  await client.close();
  expect(responseSignal!.aborted).toBe(true);
  expect(await readStateFile(dir, 'resume.json')).not.toBeNull();
});
