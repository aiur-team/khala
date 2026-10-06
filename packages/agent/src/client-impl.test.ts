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
import { migrateLegacy } from './channels';
import type { AgentMatrixSession, SessionModeCommand, SessionMessage } from './matrix/session';
import { appendInbox } from './inbox';
import { channelFiles, filesForDir, readJoinFile, writeJoinFile, joinFilePath, stateKey, ensureStateDir, readStateFile, resolveStateDir, writeStateFile } from './state';
import { toInboxEntry } from './sender';
import { deliver } from '../hooks/deliver';

vi.mock('node:fs/promises', { spy: true });
vi.mock('./channels', { spy: true });

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
const channelDir = () => channelFiles(filesForDir(dir), credentials.roomId).dir;
const statusFile = () => readStateFile<Record<string, unknown>>(dir, 'status.json');
async function connected() {
  await client.join(link, 'Codex');
  poll.resolve(credentials);
  await vi.waitFor(async () => expect((await client.status()).state).toBe('connected'));
}
async function entries() {
  await client.status();
  try { return (await fs.readFile(path.join(channelDir(), 'inbox.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
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
  expect(await readJoinFile(filesForDir(dir), link)).toEqual({ joinId: 'j', pollSecret: 'POLL', confirmUrl: created.confirmUrl, expiresAt: created.expiresAt, link });
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(joinFilePath(filesForDir(dir), stateKey(link)))).mode & 0o777).toBe(0o600);
  expect(await statusFile()).toEqual({ state: 'joining', updatedAt: now().toISOString() });
});
it('runs the handshake in order and exposes a connected client', async () => {
  await connected();
  expect(await client.status()).toMatchObject({ state: 'connected', channelName: 'Release room', agentUserId: credentials.userId, unread: 0, listeningMode: 'sync' });
  const calls = [joinApi.pollJoin, startSession, session.onMessage, joinApi.reportReady, session.waitForInvite, session.join].map(fn => vi.mocked(fn).mock.invocationCallOrder[0]!);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));
  expect(session.waitForInvite).toHaveBeenCalledWith(credentials.roomId, 120_000);
  expect(await readStateFile(channelDir(), 'session.json')).toEqual(credentials);
  expect((await fs.stat(path.join(channelDir(), 'session.json'))).mode & 0o777).toBe(0o600);
  expect(await readJoinFile(filesForDir(dir), link)).toBeNull();
  expect(await client.join(link, 'Other')).toEqual({ state: 'connected', channelName: 'Release room', channels: [credentials.roomId] });
  expect(joinApi.requestJoin).toHaveBeenCalledTimes(1);
  expect(session.stop).not.toHaveBeenCalled();
});
it('preserves the connected channel and backlog while another link is pending', async () => {
  await connected();
  handler!(message('$old'));
  await entries();
  const nextLink = 'https://khala.example/join/ijklmnop';
  poll = deferred<AgentCredentials>();
  await client.join(nextLink, 'Other');
  expect(session.stop).not.toHaveBeenCalled();
  expect(joinApi.pollJoin.mock.calls[0]![1]!.signal!.aborted).toBe(false);
  handler!(message('$after'));
  expect((await entries()).map(entry => entry.eventId)).toEqual(['$old', '$after']);
  expect((await client.status()).state).toBe('connected');
  expect((await client.status()).channels).toEqual(expect.arrayContaining([
    expect.objectContaining({ channel: nextLink, link: nextLink, state: 'joining' }),
  ]));
  await expect(client.send('for pending B')).rejects.toMatchObject({ code: 'channel_required' });
  await expect(client.read(20)).rejects.toMatchObject({ code: 'channel_required' });
  await expect(client.sendChannelEvent({ v: 1, kind: 'test', summary: 'B', body: 'B' })).rejects.toMatchObject({ code: 'channel_required' });
  expect(session.send).not.toHaveBeenCalled();
  expect(session.sendChannelEvent).not.toHaveBeenCalled();
  await client.send('explicit A', credentials.roomId);
  expect(session.send).toHaveBeenCalledWith(credentials.roomId, 'explicit A');
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
  expect(await statusFile()).toEqual({ state: 'send_failed', detail: 'send_failed', owner: { pid: process.pid, startTime: expect.any(String) }, channelName: 'Release room', updatedAt: now().toISOString() });
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
  await writeJoinFile(filesForDir(dir), link, { ...created, link, expiresAt: '2020-01-01T00:00:00Z' });
  await expect(client.join(link, 'Codex')).rejects.toMatchObject({ code: 'join_expired' });
  poll = deferred<AgentCredentials>();
  await client.join(link, 'Codex'); expect(joinApi.requestJoin).toHaveBeenCalledTimes(2);
});
it('cleans up invite timeout and contains raw session errors', async () => {
  vi.mocked(session.waitForInvite).mockRejectedValue(new Error('invite_timeout'));
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(async () => expect((await statusFile())?.detail).toBe('invite_timeout'));
  expect((await client.status()).state).toBe('disconnected');
  expect(session.stop).toHaveBeenCalledTimes(1); expect(await readStateFile(channelDir(), 'session.json')).toBeNull();
});
it('closes idempotently and cannot be revived by late credentials', async () => {
  await client.join(link, 'Codex');
  await Promise.all([client.close(), client.close()]);
  poll.resolve(credentials); await Promise.resolve();
  expect(startSession).not.toHaveBeenCalled(); expect(await readStateFile(channelDir(), 'session.json')).toBeNull();
  expect(await statusFile()).toEqual({ state: 'disconnected', detail: 'closed', updatedAt: now().toISOString() });
  await expect(client.join(link, 'Codex')).rejects.toMatchObject({ code: 'not_connected' });
});
it('stops a connected session once on close', async () => {
  await connected(); await client.close(); await client.close();
  expect(session.stop).toHaveBeenCalledTimes(1); expect(await readStateFile(channelDir(), 'session.json')).toBeNull();
  expect((await statusFile())?.channelName).toBe('Release room');
});
it('never reuses stale credentials or saved confirmation on process start', async () => {
  await ensureStateDir(dir); await writeStateFile(dir, 'session.json', credentials);
  await writeJoinFile(filesForDir(dir), link, { ...created, link });
  expect(await client.status()).toMatchObject({ state: 'idle', unread: 0, listeningMode: 'sync' });
  expect(await readStateFile(channelDir(), 'session.json')).toBeNull();
  await client.join(link, 'Codex'); expect(joinApi.requestJoin).toHaveBeenCalledTimes(1); expect(startSession).not.toHaveBeenCalled();
});
it('counts all unread kinds', async () => {
  await connected(); await appendInbox(channelDir(), toInboxEntry(message('$message')));
  await appendInbox(channelDir(), { ...toInboxEntry(message('$event')), kind: 'event' });
  expect((await client.status()).unread).toBe(2);
});
it('keeps different pending links independent when one expires', async () => {
  const expired = deferred<void>();
  const joined = deferred<void>();
  vi.mocked(session.roomName).mockImplementation(() => { joined.resolve(); return 'Release room'; });
  await client.join(link, 'Codex'); const oldPoll = poll;
  poll = deferred<AgentCredentials>();
  const nextLink = 'https://khala.example/join/ijklmnop';
  const nextCreated = { ...created, confirmUrl: 'https://khala.example/agent/confirm/next' };
  joinApi.requestJoin.mockResolvedValueOnce(nextCreated);
  expect(await client.join(nextLink, 'Codex')).toEqual({ state: 'awaiting_confirmation', confirmUrl: nextCreated.confirmUrl });
  expect(joinApi.requestJoin).toHaveBeenCalledTimes(2);
  expect(joinApi.requestJoin).toHaveBeenLastCalledWith({ link: nextLink, harness: 'codex', label: 'Codex', sessionId: 'test', rejoinSecret: expect.any(String) }, { env: { XDG_STATE_HOME: root } });
  const oldSignal = joinApi.pollJoin.mock.calls[0]![1]!.signal!;
  const nextSignal = joinApi.pollJoin.mock.calls[1]![1]!.signal!;
  expect(oldSignal.aborted).toBe(false);
  oldSignal.addEventListener('abort', () => expired.resolve(), { once: true });
  oldPoll.reject(new KhalaClientError('join_expired'));
  await expired.promise;
  expect(nextSignal.aborted).toBe(false);
  poll.resolve(credentials);
  // roomName is read after the attempt is joined; status then awaits its task.
  await joined.promise;
  expect((await client.status()).state).toBe('connected');
});
it('stops a session that finishes starting after close without reviving state', async () => {
  const starting = deferred<AgentMatrixSession>(); startSession.mockReturnValue(starting.promise);
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(() => expect(startSession).toHaveBeenCalled());
  await client.close(); starting.resolve(session);
  await vi.waitFor(() => expect(session.stop).toHaveBeenCalledTimes(1));
  expect(joinApi.reportReady).not.toHaveBeenCalled();
  expect(await readStateFile(channelDir(), 'session.json')).toBeNull(); expect((await statusFile())?.detail).toBe('closed');
});
it('contains a session startup error without leaking its token', async () => {
  startSession.mockRejectedValue(new Error('SECRET'));
  await client.join(link, 'Codex'); poll.resolve(credentials);
  await vi.waitFor(async () => expect((await statusFile())?.state).toBe('disconnected'));
  expect((await statusFile())?.detail).toBe('internal_error'); expect(await readStateFile(channelDir(), 'session.json')).toBeNull();
});
it('falls back to the room id and propagates injected fetch and invite timeout', async () => {
  const fakeFetch = vi.fn<typeof fetch>();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now,
    startSession, joinApi, fetch: fakeFetch, inviteTimeoutMs: 321 });
  vi.mocked(session.roomName).mockReturnValue(undefined);
  await connected();
  expect((await client.status()).channelName).toBe(credentials.roomId);
  expect(joinApi.requestJoin).toHaveBeenCalledWith({ link, harness: 'codex', label: 'Codex', sessionId: 'test', rejoinSecret: expect.any(String) }, { fetch: fakeFetch, env: { XDG_STATE_HOME: root } });
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
  expect(await statusFile()).toEqual({ state: 'send_failed', detail: 'send_failed', owner: { pid: process.pid, startTime: expect.any(String) }, channelName: 'Release room', updatedAt: now().toISOString() });
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
  expect(await readStateFile(channelDir(), 'mode.json')).toEqual({ mode: 'async', changedBy: 'owner', eventId: '$mode', eventTs: now().getTime(), updatedAt: now().toISOString() });
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
  expect(await readStateFile(channelDir(), 'mode.json')).toBeNull();
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
  await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await client.status()).listeningMode).toBe('sync'));
});

it('preserves message and command arrival order while joining', async () => {
  vi.mocked(session.join).mockImplementation(async () => {
    modeHandler!(modeCommand()); handler!(message('$before'));
    modeHandler!({ ...modeCommand({ v: 1, agent: credentials.userId, mode: 'sync' }), eventId: '$sync-mode' });
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
  expect(await client.join(link, 'Codex')).toEqual({ state: 'connected', channelName: 'Release room', channels: [credentials.roomId] });
  expect((await client.status()).state).toBe('connected');
  const calls = [joinApi.pollJoin, startSession, session.onMessage, joinApi.reportReady, session.waitForInvite, session.join].map(fn => vi.mocked(fn).mock.invocationCallOrder[0]!);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));
  expect(await readStateFile(channelDir(), 'session.json')).toEqual({ ...credentials, transport: 'local' });
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
  expect(await readStateFile(channelDir(), 'mode.json')).toEqual({ mode: 'async' });
});

it('replaces a rejoin.json that parses but holds an invalid secret instead of failing every start', async () => {
  await ensureStateDir(dir);
  await writeStateFile(dir, 'rejoin.json', { secret: 'not-a-secret' });
  await client.join(link, 'Codex');
  const secret = (await readStateFile<{ secret: string }>(dir, 'rejoin.json'))!.secret;
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await fs.stat(path.join(dir, 'rejoin.json'))).mode & 0o777).toBe(0o600);
  expect(joinApi.requestJoin).toHaveBeenCalledWith({ link, harness: 'codex', label: 'Codex', sessionId: 'test', rejoinSecret: secret }, { env: { XDG_STATE_HOME: root } });
  expect((await client.status()).state).not.toBe('error');
  await client.close();
  const restarted = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  try {
    await restarted.join(link, 'Codex');
    expect(joinApi.requestJoin).toHaveBeenLastCalledWith(expect.objectContaining({ rejoinSecret: secret }), { env: { XDG_STATE_HOME: root } });
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

it('process sources create fresh hosted members and never persist a rejoin secret', async () => {
  const env = { XDG_STATE_HOME: root };
  const clients = [0, 1].map(() => createKhalaAgentClient({ harness: 'codex', sessionId: 'proc-100-start-100',
    rejoinable: false, env, now, startSession, joinApi }));
  try {
    for (const client of clients) await client.join(link, 'Codex');
    expect(joinApi.requestJoin.mock.calls.map(call => call[0])).toEqual([
      { link, harness: 'codex', label: 'Codex' }, { link, harness: 'codex', label: 'Codex' },
    ]);
    expect(await readStateFile(resolveStateDir('codex', 'proc-100-start-100', env), 'rejoin.json')).toBeNull();
  } finally { await Promise.all(clients.map(client => client.close())); }
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
    // Part 3 owns hook channel enumeration; provide the legacy fixture for rendering here.
    await fs.copyFile(path.join(channelDir(), 'inbox.jsonl'), path.join(dir, 'inbox.jsonl'));
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
  await fs.copyFile(path.join(channelDir(), 'inbox.jsonl'), path.join(dir, 'inbox.jsonl'));
  let out = '';
  await deliver(JSON.stringify({ session_id: 'test', hook_event_name: 'UserPromptSubmit' }), ['--harness', 'codex'],
    { stdout: { write: (text: string) => { out += text; } }, stderr: { write: () => {} }, env: { XDG_STATE_HOME: root }, now });
  expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(' you="kevin-Codex" ');
});

async function multiClient(names = ['A', 'B']) {
  await client.close();
  const controls = names.map((name, index) => {
    const creds = { ...credentials, roomId: `!${name}:local`, userId: `@agent-${index}:local`, transport: 'local' as const };
    let receive: ((message: SessionMessage) => void) | undefined;
    let mode: ((command: SessionModeCommand) => void) | undefined;
    let ended: ((reason: 'removed') => void) | undefined;
    const ownSession = { ...session, userId: creds.userId,
      displayName: vi.fn(() => `owner-Codex-${index}`), roomName: vi.fn(() => name),
      send: vi.fn(async () => ({ eventId: `$sent-${name}` })), sendChannelEvent: vi.fn(async () => ({ eventId: `$event-${name}` })),
      stop: vi.fn(async () => {}), listeningMode: vi.fn(() => 'sync' as const),
      onMessage: vi.fn(callback => { receive = callback; return () => {}; }) as typeof session.onMessage,
      onListeningModeCommand: vi.fn(callback => { mode = callback; return () => {}; }) as typeof session.onListeningModeCommand,
      onEnded: (callback: (reason: 'removed') => void) => { ended = callback; return () => {}; },
    };
    return { creds, session: ownSession, receive: (input: SessionMessage) => receive!(input), mode: (input: SessionModeCommand) => mode!(input), ended: () => ended!('removed') };
  });
  const api = {
    requestJoin: vi.fn(async (input: Parameters<typeof requestJoin>[0]) => ({ ...created, joinId: input.link, autoConfirmed: true as const })),
    pollJoin: vi.fn(async (input: Parameters<typeof pollJoin>[0]) => controls[Number(input.joinId.split('/').at(-1))]!.creds),
    reportReady: vi.fn(async () => {}),
  };
  const start = vi.fn(async (creds: AgentCredentials) => controls.find(item => item.creds.roomId === creds.roomId)!.session);
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: api, startSession: start });
  const files = filesForDir(resolveStateDir('codex', 'multi', { XDG_STATE_HOME: root }));
  const join = (index: number) => client.join(`http://127.0.0.1:47830/join/${index}`, 'Codex');
  const inbox = async (index: number) => {
    await client.status();
    try { return (await fs.readFile(channelFiles(files, controls[index]!.creds.roomId).inbox, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    catch { return []; }
  };
  return { controls, api, files, join, inbox, start };
}

it('joins different channels concurrently, retains intake, and requires explicit routing', async () => {
  const f = await multiClient();
  const [a, b] = await Promise.all([f.join(0), f.join(1)]);
  expect(a.state).toBe('connected'); expect(b.state).toBe('connected');
  f.controls[0]!.receive({ ...message('$after-B'), roomId: f.controls[0]!.creds.roomId });
  expect((await f.inbox(0)).map(entry => entry.eventId)).toEqual(['$after-B']);
  expect((await client.status()).channels).toEqual([
    expect.objectContaining({ channel: 'A', state: 'connected', you: 'owner-Codex-0', unread: 1 }),
    expect.objectContaining({ channel: 'B', state: 'connected', you: 'owner-Codex-1', unread: 0 }),
  ]);
  const channels = [{ channel: 'A', roomId: '!A:local' }, { channel: 'B', roomId: '!B:local' }];
  for (const operation of [() => client.send('wrong'), () => client.read(20), () => client.sendChannelEvent({ v: 1, kind: 'test', summary: 'test', body: 'test' })]) {
    await expect(operation()).rejects.toMatchObject({ code: 'channel_required', extra: { channels } });
  }
  expect(f.controls[0]!.session.send).not.toHaveBeenCalled();
  expect(f.controls[1]!.session.send).not.toHaveBeenCalled();
  await client.send('routed', '#b');
  expect(f.controls[1]!.session.send).toHaveBeenCalledExactlyOnceWith('!B:local', 'routed');
  expect((await client.status('!A:local')).channelName).toBe('A');
});

it('leaves only the selected channel and rejects stale callbacks and credentials', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  expect(await client.leave('A')).toEqual({ left: 'A', channels: ['!B:local'] });
  expect(f.controls[0]!.session.stop).toHaveBeenCalledOnce();
  expect(f.controls[1]!.session.stop).not.toHaveBeenCalled();
  await expect(fs.stat(channelFiles(f.files, '!A:local').dir)).rejects.toMatchObject({ code: 'ENOENT' });
  f.controls[0]!.receive({ ...message('$stale'), roomId: '!A:local' });
  f.controls[0]!.ended();
  await expect(client.send('stale', 'A')).rejects.toMatchObject({ code: 'channel_unknown' });
  await client.send('only-B');
  expect(f.controls[1]!.session.send).toHaveBeenCalledWith('!B:local', 'only-B');
  expect((await client.status()).state).toBe('connected');
});

it('ends one removed session while another remains connected', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  f.controls[0]!.ended();
  await vi.waitFor(async () => expect((await client.status('A')).state).toBe('disconnected'));
  expect((await client.status('A')).detail).toBe('removed');
  expect((await client.status('B')).state).toBe('connected');
  expect((await client.status()).state).toBe('connected');
  await expect(client.send('removed', 'A')).rejects.toMatchObject({ code: 'not_connected' });
});

it('drops cross-room messages and cross-room or cross-agent mode commands', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  f.controls[0]!.receive({ ...message('$wrong-room'), roomId: '!B:local' });
  f.controls[0]!.mode({ ...modeCommand(), roomId: '!B:local', content: { v: 1, agent: f.controls[0]!.creds.userId, mode: 'async' } });
  f.controls[0]!.mode({ ...modeCommand(), roomId: '!A:local', content: { v: 1, agent: f.controls[1]!.creds.userId, mode: 'async' } });
  expect(await f.inbox(0)).toEqual([]); expect(await f.inbox(1)).toEqual([]);
  for (const room of ['!A:local', '!B:local']) expect(await readStateFile(channelFiles(f.files, room).dir, 'mode.json')).toEqual({ mode: 'sync' });
  f.controls[0]!.mode({ ...modeCommand(), roomId: '!A:local', content: { v: 1, agent: f.controls[0]!.creds.userId, mode: 'async' } });
  await vi.waitFor(async () => expect((await client.status('A')).listeningMode).toBe('async'));
  expect((await client.status('B')).listeningMode).toBe('sync');
});

it('coalesces same-link joins without duplicating entries and preserves one root secret', async () => {
  const f = await multiClient();
  await Promise.all([f.join(0), f.join(0), f.join(1)]);
  expect(f.api.requestJoin).toHaveBeenCalledTimes(2);
  const requests = f.api.requestJoin.mock.calls.map(([input]) => input);
  expect(requests[0]!.rejoinSecret).toBe(requests[1]!.rejoinSecret);
  expect((await client.status()).channels).toHaveLength(2);
  expect((await f.join(0)).state).toBe('connected');
  expect(f.api.requestJoin).toHaveBeenCalledTimes(2);
});

it('replaces credentials for the same room through another link without losing backlog', async () => {
  const f = await multiClient(['A']); await f.join(0);
  f.controls[0]!.receive({ ...message('$backlog'), roomId: '!A:local' }); await f.inbox(0);
  const freshCredentials = { ...f.controls[0]!.creds, accessToken: 'fresh' };
  f.api.pollJoin.mockResolvedValueOnce(freshCredentials);
  let freshReceive!: (message: SessionMessage) => void;
  const freshSession = { ...f.controls[0]!.session, stop: vi.fn(async () => {}),
    onMessage: vi.fn((callback: (message: SessionMessage) => void) => { freshReceive = callback; return () => {}; }) };
  f.start.mockResolvedValueOnce(freshSession);
  expect((await client.join('http://127.0.0.1:47830/join/replacement', 'Codex')).state).toBe('connected');
  expect(f.controls[0]!.session.stop).toHaveBeenCalledOnce();
  expect((await client.status()).channels).toHaveLength(1);
  expect(f.start).toHaveBeenLastCalledWith(freshCredentials, { checkRemoved: expect.any(Function) });
  f.controls[0]!.receive({ ...message('$stale-session'), roomId: '!A:local' });
  freshReceive({ ...message('$fresh-session'), roomId: '!A:local' });
  expect((await f.inbox(0)).map(item => item.eventId)).toEqual(['$backlog', '$fresh-session']);
  expect(freshSession.stop).not.toHaveBeenCalled();
});

it('reserves capacity across concurrent links and stops all sessions on close', async () => {
  const f = await multiClient(Array.from({ length: 17 }, (_, index) => `C${index}`));
  const results = await Promise.allSettled(Array.from({ length: 17 }, (_, index) => f.join(index)));
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(16);
  expect(results.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'channel_limit' } });
  expect((await client.status()).channels).toHaveLength(16);
  await client.close();
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') expect(f.controls[index]!.session.stop).toHaveBeenCalledOnce();
    else expect(f.controls[index]!.session.stop).not.toHaveBeenCalled();
  });
  expect(await readStateFile(f.files.dir, 'status.json')).toMatchObject({ state: 'disconnected', detail: 'closed' });
});

it('migrates legacy backlog before clearing credentials and preserves it on restart and rejoin', async () => {
  const f = await multiClient(['A']);
  await ensureStateDir(f.files.dir);
  await writeStateFile(f.files.dir, 'session.json', f.controls[0]!.creds);
  await writeStateFile(f.files.dir, 'status.json', { state: 'connected', channelName: 'A', updatedAt: now().toISOString() });
  await appendInbox(f.files.dir, toInboxEntry({ ...message('$legacy'), roomId: '!A:local' }));
  await writeStateFile(f.files.dir, 'cursor.json', { lastDeliveredEventId: null, deliveredCount: 0 });
  const secret = 'S'.repeat(43);
  await writeStateFile(f.files.dir, 'rejoin.json', { secret });
  await f.join(0);
  expect((await f.inbox(0)).map(item => item.eventId)).toEqual(['$legacy']);
  expect((await client.status()).unread).toBe(1);
  expect(await readStateFile(channelFiles(f.files, '!A:local').dir, 'cursor.json')).toMatchObject({ deliveredCount: 0 });
  expect(await readStateFile(f.files.dir, 'session.json')).toBeNull();
  expect(f.api.requestJoin.mock.calls[0]![0].rejoinSecret).toBe(secret);
  await client.close();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now,
    joinApi: f.api, startSession: async () => f.controls[0]!.session });
  await client.status();
  expect(await readStateFile(channelFiles(f.files, '!A:local').dir, 'session.json')).toBeNull();
  await f.join(0);
  expect((await client.status()).unread).toBe(1);
  expect((await f.inbox(0)).map(item => item.eventId)).toEqual(['$legacy']);
  expect(f.api.requestJoin.mock.calls.at(-1)![0].rejoinSecret).toBe(secret);
});

it('rejoins an ended channel and persisted channels when all sixteen slots are occupied', async () => {
  const f = await multiClient(Array.from({ length: 16 }, (_, index) => `C${index}`));
  await Promise.all(f.controls.map((_, index) => f.join(index)));
  f.controls[0]!.ended();
  await vi.waitFor(async () => expect((await client.status('C0')).state).toBe('disconnected'));
  expect((await f.join(0)).state).toBe('connected');
  expect((await client.status()).channels).toHaveLength(16);
  await client.close();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: f.api,
    startSession: async creds => f.controls.find(item => item.creds.roomId === creds.roomId)!.session });
  await Promise.all(f.controls.map((_, index) => f.join(index)));
  expect((await client.status()).channels).toHaveLength(16);
  expect((await client.status()).channels!.every(channel => channel.state === 'connected')).toBe(true);
});

it('keeps a failed leave selectable so removal can be retried', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('disk failure'));
  try {
    await expect(client.leave('A')).rejects.toThrow('disk failure');
    expect((await client.status('A')).state).toBe('disconnected');
    expect((await client.status('B')).state).toBe('connected');
    expect(await client.leave('A')).toEqual({ left: 'A', channels: ['!B:local'] });
  } finally { remove.mockRestore(); }
});

it('close drains a concurrent leave and keeps the root closed marker', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  const stopping = deferred<void>();
  f.controls[0]!.session.stop.mockImplementationOnce(() => stopping.promise);
  const leaving = client.leave('A');
  await vi.waitFor(() => expect(f.controls[0]!.session.stop).toHaveBeenCalledOnce());
  let finished = false;
  const closing = client.close().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  stopping.resolve();
  await Promise.all([leaving, closing]);
  expect(await readStateFile(f.files.dir, 'status.json')).toMatchObject({ state: 'disconnected', detail: 'closed' });
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


it.each([false, true])('legacy leave preserves root identity and other channels (collision=%s)', async collision => {
  await client.close();
  const files = filesForDir(dir);
  const other = channelFiles(files, '!other:s');
  await ensureStateDir(other.dir);
  await writeStateFile(other.dir, 'channel.json', { roomId: '!other:s', channelName: 'Other' });
  await fs.writeFile(other.inbox, 'other backlog\n');
  if (collision) {
    const nested = channelFiles(files, credentials.roomId);
    await ensureStateDir(nested.dir);
    await writeStateFile(nested.dir, 'channel.json', { roomId: credentials.roomId, channelName: 'Legacy' });
    await fs.writeFile(nested.inbox, 'nested backlog\n');
  }
  const secret = 'S'.repeat(43);
  await writeStateFile(dir, 'rejoin.json', { secret });
  await writeStateFile(dir, 'status.json', { channelName: 'Legacy' });
  await fs.writeFile(files.inbox, JSON.stringify({ roomId: credentials.roomId }) + '\n');
  await fs.writeFile(path.join(dir, 'activity.json'), JSON.stringify({ alive: true }));
  await fs.writeFile(path.join(dir, 'watcher.json'), JSON.stringify({ armed: true }));
  const savedJoin = { ...created, link: 'https://khala.example/join/pending9' };
  await writeJoinFile(files, savedJoin.link, savedJoin);
  // Model a concurrent legacy writer after migration, keeping both layouts discoverable.
  vi.mocked(migrateLegacy).mockResolvedValueOnce('none');
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  await client.leave('Legacy');
  expect(await readStateFile(dir, 'rejoin.json')).toEqual({ secret });
  expect(await readStateFile(dir, 'activity.json')).toEqual({ alive: true });
  expect(await readStateFile(dir, 'watcher.json')).toEqual({ armed: true });
  expect(await readJoinFile(files, savedJoin.link)).toMatchObject({ link: savedJoin.link });
  expect(await fs.readFile(other.inbox, 'utf8')).toBe('other backlog\n');
  if (collision) {
    await expect(fs.stat(channelFiles(files, credentials.roomId).dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(files.inbox, 'utf8')).toContain(credentials.roomId);
  } else {
    await expect(fs.stat(files.inbox)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('migrates colliding legacy unread history before leave without deleting sibling state', async () => {
  const files = filesForDir(dir);
  const nested = channelFiles(files, credentials.roomId);
  const other = channelFiles(files, '!other:s');
  for (const [target, roomId, channelName] of [[nested, credentials.roomId, 'A'], [other, '!other:s', 'B']] as const) {
    await ensureStateDir(target.dir);
    await writeStateFile(target.dir, 'channel.json', { roomId, channelName });
  }
  for (const id of ['$old', '$overlap']) await appendInbox(nested.dir, toInboxEntry(message(id)));
  await writeStateFile(nested.dir, 'cursor.json', { lastDeliveredEventId: '$old', deliveredCount: 1 });
  await writeStateFile(nested.dir, 'mode.json', { mode: 'async' });
  for (const id of ['$root-read', '$overlap', '$new']) await appendInbox(dir, toInboxEntry(message(id)));
  await writeStateFile(dir, 'session.json', credentials);
  await writeStateFile(dir, 'cursor.json', { lastDeliveredEventId: '$root-read', deliveredCount: 1 });
  await writeStateFile(dir, 'mode.json', { mode: 'sync' });
  const secret = 'S'.repeat(43);
  await writeStateFile(dir, 'rejoin.json', { secret });
  const status = await client.status();
  expect(status.channels).toHaveLength(2);
  expect(status.channels).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'A', unread: 2, listeningMode: 'async' })]));
  expect((await fs.readFile(nested.inbox, 'utf8')).trim().split('\n').map(line => JSON.parse(line).eventId)).toEqual(['$old', '$overlap', '$new']);
  expect(await readStateFile(nested.dir, 'cursor.json')).toMatchObject({ deliveredCount: 1 });
  await client.leave('A');
  expect(await readStateFile(dir, 'rejoin.json')).toEqual({ secret });
  expect(await readStateFile(other.dir, 'channel.json')).toMatchObject({ roomId: '!other:s' });
});

it('preserves the own name in the first delivered frame after restart before reconnecting', async () => {
  vi.mocked(session.displayName).mockImplementation(user => user === credentials.userId ? 'Scout' : 'Maya');
  await connected();
  handler!(message('$before-restart'));
  await client.status();
  await client.close();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  await client.status();
  expect(await readStateFile(channelDir(), 'status.json')).toMatchObject({ state: 'disconnected', displayName: 'Scout' });
  let out = '';
  await deliver(JSON.stringify({ session_id: 'test', hook_event_name: 'UserPromptSubmit' }), ['--harness', 'codex'],
    { stdout: { write: text => { out += text; } }, stderr: { write: () => {} }, env: { XDG_STATE_HOME: root }, now });
  expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('you="Scout"');
});

async function restartMulti(f: Awaited<ReturnType<typeof multiClient>>, env: NodeJS.ProcessEnv = { XDG_STATE_HOME: root }) {
  await client.close();
  f.api.requestJoin.mockClear(); f.api.pollJoin.mockClear(); f.start.mockClear();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env, now, joinApi: f.api, startSession: f.start });
  await client.resume!();
  await vi.waitFor(async () => {
    for (const control of f.controls) {
      const channel = channelFiles(f.files, control.creds.roomId).dir;
      const record = await readStateFile(channel, 'resume.json');
      if (record) expect(await readStateFile(channel, 'status.json')).not.toHaveProperty('detail', 'closed');
    }
  });
  await vi.waitFor(async () => expect((await client.status()).channels?.some(item => item.state === 'joining')).toBe(false));
}
it('restores two local channels independently without consuming their single-use links', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  await restartMulti(f);
  expect((await client.status()).channels?.map(item => item.state)).toEqual(['connected', 'connected']);
  expect(f.api.requestJoin).not.toHaveBeenCalled(); expect(f.api.pollJoin).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledTimes(2);
});
it('restores two hosted channels through fresh secret-confirmed joins without storing bearer credentials', async () => {
  const f = await multiClient();
  for (const control of f.controls) delete (control.creds as AgentCredentials).transport;
  await Promise.all([f.join(0), f.join(1)]);
  for (const control of f.controls) {
    const saved = await readStateFile<Record<string, unknown>>(channelFiles(f.files, control.creds.roomId).dir, 'resume.json');
    expect(saved).not.toHaveProperty('localCredentials'); expect(JSON.stringify(saved)).not.toContain('SECRET');
  }
  await restartMulti(f);
  expect(f.api.requestJoin).toHaveBeenCalledTimes(2); expect(f.api.pollJoin).toHaveBeenCalledTimes(2);
  expect((await client.status()).channels?.map(item => item.state)).toEqual(['connected', 'connected']);
});
it('leaving one channel only restores the other on the next startup', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  await client.leave('A'); await restartMulti(f);
  expect((await client.status()).channels).toEqual([expect.objectContaining({ channel: 'B', state: 'connected' })]);
  expect(f.start).toHaveBeenCalledTimes(1);
});
it('does not restore owner-removed channels', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  f.controls[0]!.ended();
  await vi.waitFor(async () => expect(await readStateFile(channelFiles(f.files, '!A:local').dir, 'resume.json')).toBeNull());
  await restartMulti(f); expect(f.start).toHaveBeenCalledTimes(1);
});
it.each(['missing', 'invalid', 'changed'])('does not restore with a %s rejoin secret', async kind => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]); await client.close();
  if (kind === 'missing') await fs.rm(path.join(f.files.dir, 'rejoin.json'));
  else await writeStateFile(f.files.dir, 'rejoin.json', { secret: kind === 'invalid' ? 'short' : 'z'.repeat(43) });
  await restartMulti(f); expect(f.start).not.toHaveBeenCalled(); expect(f.api.requestJoin).not.toHaveBeenCalled();
});
it('does not restore authorization from another workspace', async () => {
  const f = await multiClient(); await Promise.all([f.join(0), f.join(1)]);
  await restartMulti(f, { XDG_STATE_HOME: root, PWD: path.join(root, 'other-workspace') });
  expect(f.start).not.toHaveBeenCalled();
});
it('keeps hosted restoration non-terminal when old control needs owner approval', async () => {
  const f = await multiClient(['A']); delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); (f.api.requestJoin as Mock<typeof requestJoin>).mockResolvedValue(created);
  await restartMulti(f); expect(f.api.pollJoin).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  expect(await readStateFile(channelFiles(f.files, '!A:local').dir, 'resume.json')).not.toBeNull();
  expect(await client.status('A')).toMatchObject({ state: 'disconnected', detail: 'rejoin_needed' });
  expect(await readJoinFile(f.files, 'http://127.0.0.1:47830/join/0')).toBeNull();
  (f.api.requestJoin as Mock<typeof requestJoin>).mockResolvedValue({ ...created, joinId: 'http://127.0.0.1:47830/join/0' });
  expect(await f.join(0)).toEqual({ state: 'awaiting_confirmation', confirmUrl: created.confirmUrl });
  await vi.waitFor(async () => expect(await client.status('A')).toMatchObject({ state: 'connected' }));
});
it('retains authorization after transient hosted restoration failures and retries next startup', async () => {
  const f = await multiClient(['A']); delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); f.api.requestJoin.mockRejectedValueOnce(new KhalaClientError('internal_error', 'network'));
  await restartMulti(f); expect(f.start).not.toHaveBeenCalled();
  expect(await readStateFile(channelFiles(f.files, '!A:local').dir, 'resume.json')).not.toBeNull();
  await restartMulti(f); await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
});
it('cancels a pending restoration request during shutdown', async () => {
  const f = await multiClient(['A']); delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); await client.close(); f.api.requestJoin.mockImplementation(() => new Promise(() => {}));
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: f.api, startSession: f.start });
  const restoration = client.resume!();
  await vi.waitFor(() => expect(f.api.requestJoin).toHaveBeenCalledTimes(2));
  await client.close(); await restoration;
  expect((await client.status()).detail).toBe('closed');
});

it('preserves per-channel name metadata during startup and transient hosted failure', async () => {
  const f = await multiClient(['A']); delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); await client.close();
  const pending = deferred<Awaited<ReturnType<typeof requestJoin>>>();
  (f.api.requestJoin as Mock<typeof requestJoin>).mockImplementation(() => pending.promise);
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: f.api, startSession: f.start });
  await client.resume!();
  const directory = channelFiles(f.files, '!A:local').dir;
  await vi.waitFor(async () => expect(await readStateFile(directory, 'status.json')).toMatchObject({ state: 'joining', channelName: 'A', displayName: 'owner-Codex-0' }));
  // Joining status is written before the request starts; wait until the client
  // has attached its request handler before rejecting the deferred response.
  await vi.waitFor(() => expect(f.api.requestJoin).toHaveBeenCalledTimes(2));
  pending.reject(new KhalaClientError('internal_error', 'network'));
  await vi.waitFor(async () => expect(await readStateFile(directory, 'status.json')).toMatchObject({ state: 'disconnected', detail: 'network', channelName: 'A', displayName: 'owner-Codex-0' }));
});
it('delivers restored-channel wake entries without a tool call', async () => {
  const f = await multiClient(['A']); await f.join(0); await client.close();
  const wake = vi.fn();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: f.api, startSession: f.start, onInboxAppend: wake });
  await client.resume!();
  await vi.waitFor(() => expect(f.controls[0]!.session.join).toHaveBeenCalledTimes(2));
  f.controls[0]!.receive({ ...message('$restored-wake'), roomId: '!A:local' });
  await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ eventId: '$restored-wake' })));
});

it('leaves a channel while restoration is requesting authorization without recreating its directory', async () => {
  const f = await multiClient(['A']); delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); await client.close();
  const pending = deferred<Awaited<ReturnType<typeof requestJoin>>>();
  (f.api.requestJoin as Mock<typeof requestJoin>).mockImplementation(() => pending.promise);
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: f.api, startSession: f.start });
  await client.resume!();
  await vi.waitFor(() => expect(f.api.requestJoin).toHaveBeenCalledTimes(2));
  await client.leave('A'); pending.resolve({ ...created, autoConfirmed: true });
  await client.close();
  await expect(fs.stat(channelFiles(f.files, '!A:local').dir)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([[401, 'unauthorized'], [403, 'removed'], [404, 'channel_deleted']] as const)('forgets local restoration after terminal helper response %i', async (status, detail) => {
  const f = await multiClient(['A']); await f.join(0); await client.close();
  vi.mocked(f.controls[0]!.session.waitForInvite).mockRejectedValueOnce(Object.assign(new Error('helper rejected credentials'), { status }));
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now, joinApi: f.api, startSession: f.start });
  await client.resume!();
  const directory = channelFiles(f.files, '!A:local').dir;
  await vi.waitFor(async () => expect(await readStateFile(directory, 'status.json')).toMatchObject({ state: 'disconnected', detail }));
  expect(await readStateFile(directory, 'resume.json')).toBeNull();
});

it('keeps an MCP-only client Async and returns its current identity', async () => {
  await client.close();
  vi.mocked(session.displayName).mockReturnValue('kevin-Agent');
  client = createKhalaAgentClient({ harness: 'cline', sessionId: 'test', env: { XDG_STATE_HOME: root }, now, startSession, joinApi });
  expect((await client.status()).listeningMode).toBe('async');
  await connected();
  expect(await client.status()).toMatchObject({ you: 'kevin-Agent', displayName: 'kevin-Agent', listeningMode: 'async',
    channels: [expect.objectContaining({ you: 'kevin-Agent', listeningMode: 'async' })] });
  expect(session.publishListeningMode).toHaveBeenCalledWith(credentials.roomId, 'async', expect.any(AbortSignal));
  modeHandler!(modeCommand({ v: 1, agent: credentials.userId, mode: 'sync' }));
  expect((await client.status()).listeningMode).toBe('async');
  expect((await client.read(10)).you).toBe('kevin-Agent');
});


it('ignores duplicate and older owner mode commands replayed from the saved sync', async () => {
  await connected(); modeHandler!(modeCommand()); await client.status();
  vi.mocked(session.publishListeningMode).mockClear();
  modeHandler!(modeCommand());
  modeHandler!({ ...modeCommand({ v: 1, agent: credentials.userId, mode: 'sync' }), eventId: '$old-mode', ts: now().getTime() - 1 });
  expect((await client.status()).listeningMode).toBe('async');
  expect(session.publishListeningMode).not.toHaveBeenCalled();
});


it.each(['missing', 'invalid', 'changed', 'workspace', 'offline', 'server-error', 'revoked'])('logs out and wipes saved crypto when %s resume authorization is discarded', async kind => {
  vi.resetModules();
  const f = await multiClient(['A']);
  delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); await client.close();
  const channelDir = channelFiles(f.files, f.controls[0]!.creds.roomId).dir;
  await fs.writeFile(path.join(channelDir, 'crypto.json'), JSON.stringify(f.controls[0]!.creds), { mode: 0o600 });
  if (kind === 'missing') await fs.rm(path.join(f.files.dir, 'rejoin.json'));
  else if (kind !== 'workspace') await writeStateFile(f.files.dir, 'rejoin.json', { secret: kind === 'invalid' ? 'short' : 'z'.repeat(43) });
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (kind === 'offline') throw new Error('offline');
    return Response.json({}, { status: kind === 'server-error' ? 503 : kind === 'revoked' ? 401 : 200 });
  });
  f.api.requestJoin.mockClear(); f.start.mockClear();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi',
    env: { XDG_STATE_HOME: root, ...(kind === 'workspace' ? { PWD: path.join(root, 'other-workspace') } : {}) },
    now, joinApi: f.api, startSession: f.start, fetch: fetcher });
  await client.resume!();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${credentials.homeserver}/_matrix/client/v3/logout`,
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: `Bearer ${credentials.accessToken}` }) }));
  expect(await readStateFile(channelDir, 'crypto.json')).toBeNull();
  expect(await readStateFile(channelDir, 'resume.json')).toBeNull();
  expect(f.api.requestJoin).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  vi.resetModules();
});

it('logs out the old device before starting a replacement after a corrupt store reset', async () => {
  vi.resetModules();
  const cryptoStore = await import('./matrix/crypto-store');
  const f = await multiClient(['A']);
  delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); await client.close();
  const channelDir = channelFiles(f.files, f.controls[0]!.creds.roomId).dir;
  const old = { ...f.controls[0]!.creds, deviceId: 'OLD', accessToken: 'old-token' };
  await fs.writeFile(path.join(channelDir, 'crypto.json'), JSON.stringify(old), { mode: 0o600 });
  await fs.writeFile(path.join(channelDir, 'crypto.sqlite'), 'corrupt sqlite', { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async input => String(input).endsWith('/whoami')
    ? Response.json({ user_id: old.userId, device_id: old.deviceId }) : Response.json({}));
  f.start.mockClear();
  f.start.mockImplementation(async creds => {
    if (creds.deviceId === 'OLD') {
      await cryptoStore.openCryptoStore(channelDir, path.join(root, 'khala'), creds);
      throw new Error('expected corrupt store');
    }
    expect(fetcher).toHaveBeenCalledWith(`${old.homeserver}/_matrix/client/v3/logout`,
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer old-token' }) }));
    expect(await readStateFile(channelDir, 'crypto.json')).toBeNull();
    return f.controls[0]!.session;
  });
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now,
    joinApi: f.api, startSession: f.start, fetch: fetcher });
  await client.resume!();
  await vi.waitFor(async () => expect(await client.status('A')).toMatchObject({ state: 'connected', detail: 'crypto_reset' }));
  expect(f.start.mock.calls.map(([creds]) => creds.deviceId)).toEqual(['OLD', credentials.deviceId]);
  vi.resetModules();
});

it('wipes a token revoked while offline before automatic rejoin can renew it', async () => {
  const f = await multiClient(['A']);
  delete (f.controls[0]!.creds as AgentCredentials).transport;
  await f.join(0); await client.close();
  const channelDir = channelFiles(f.files, f.controls[0]!.creds.roomId).dir;
  await fs.writeFile(path.join(channelDir, 'crypto.json'), JSON.stringify(f.controls[0]!.creds), { mode: 0o600 });
  f.api.requestJoin.mockClear();
  client = createKhalaAgentClient({ harness: 'codex', sessionId: 'multi', env: { XDG_STATE_HOME: root }, now,
    joinApi: f.api, startSession: f.start, fetch: vi.fn(async () => Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 })) });
  await client.resume!();
  await vi.waitFor(async () => expect((await client.status()).channels?.[0]).toMatchObject({ state: 'disconnected', detail: 'unauthorized' }));
  expect(f.api.requestJoin).not.toHaveBeenCalled();
  expect(await readStateFile(channelDir, 'crypto.json')).toBeNull();
  expect(await readStateFile(channelDir, 'resume.json')).toBeNull();
});

it.each(['reject', 'timeout'] as const)('retries a replayed mode command after publish %s without checkpointing it', async failure => {
  await connected();
  if (failure === 'reject') vi.mocked(session.publishListeningMode).mockRejectedValueOnce(new Error('offline'));
  else { vi.useFakeTimers(); vi.mocked(session.publishListeningMode).mockImplementationOnce(() => new Promise(() => {})); }
  try {
    modeHandler!(modeCommand());
    if (failure === 'timeout') {
      await vi.waitFor(() => expect(session.publishListeningMode).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5000);
    }
    await client.status();
    expect(await readStateFile(channelDir(), 'mode.json')).toMatchObject({ eventId: '$mode', pendingPublish: true });
    modeHandler!(modeCommand());
    expect((await client.status()).listeningMode).toBe('async');
    expect(await readStateFile(channelDir(), 'mode.json')).toMatchObject({ eventId: '$mode', mode: 'async' });
    expect(await readStateFile(channelDir(), 'mode.json')).not.toHaveProperty('pendingPublish');
  } finally { vi.useRealTimers(); }
});
