import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMatrixSession } from './session';

const sdk = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => sdk.client),
  ClientEvent: { Sync: 'sync', Room: 'room' }, RoomEvent: { Timeline: 'timeline', MyMembership: 'membership' },
  MatrixEventEvent: { Decrypted: 'decrypted' }, SyncState: { Prepared: 'PREPARED', Syncing: 'SYNCING' },
  EventType: { RoomMember: 'm.room.member' },
  Direction: { Backward: 'b' }, Method: { Get: 'GET' },
}));
import { createAgentMatrixSession } from './session';

const creds = { homeserver: 'https://hs', userId: '@agent:hs', accessToken: 'secret', deviceId: 'D', roomId: '' };
function event(id = '$one', sender = '@human:hs', ts = 100, type = 'm.room.message', content: Record<string, unknown> = { body: 'hello' }, failure = false) {
  return { getId: () => id, getSender: () => sender, getTs: () => ts, getType: () => type, getContent: () => content, getRoomId: () => '!r:hs', isDecryptionFailure: () => failure };
}
let client: ReturnType<typeof fake>;
let session: AgentMatrixSession | undefined;
let membership: string;
let memberContent: Record<string, unknown> | undefined;
function fake() {
  const bus = new EventEmitter();
  let sync: string | null = null;
  const crypto = {
    getVersion: () => 'rust-test', isCrossSigningReady: vi.fn().mockResolvedValue(true),
    userHasCrossSigningKeys: vi.fn().mockResolvedValue(false),
    bootstrapCrossSigning: vi.fn(async (opts: { authUploadDeviceSigningKeys: (f: (auth: null) => Promise<void>) => Promise<void> }) => { await opts.authUploadDeviceSigningKeys(auth); crypto.isCrossSigningReady.mockResolvedValue(true); }),
  };
  const auth = vi.fn().mockResolvedValue(undefined);
  const room = { roomId: '!r:hs', name: 'Channel', getMyMembership: () => membership, currentState: { getStateEvents: vi.fn((_type: string, user: string) => user === creds.userId ? event('$join', membership === 'invite' ? '@owner:hs' : user, 100, 'm.room.member', { membership, displayname: 'Agent', avatar_url: 'mxc://hs/avatar' }) : memberContent ? event('$member', user, 1, 'm.room.member', memberContent) : null) } };
  return Object.assign(bus, {
    crypto, auth, room, initRustCrypto: vi.fn().mockResolvedValue(undefined), getCrypto: () => crypto,
    getSyncState: () => sync,
    startClient: vi.fn(async () => { sync = 'PREPARED'; bus.emit('sync', sync); }),
    stopClient: vi.fn(), getRoom: vi.fn(() => room),
    joinRoom: vi.fn(async () => { membership = 'join'; bus.emit('membership', room, 'join'); return room; }),
    decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
    getEventMapper: () => (e: unknown) => e,
    createMessagesRequest: vi.fn().mockResolvedValue({ chunk: [], end: undefined }),
    http: { authedRequest: vi.fn().mockResolvedValue({ start: 'cursor' }) },
    sendStateEvent: vi.fn().mockResolvedValue({ event_id: '$state' }),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$event' }),
    sendTextMessage: vi.fn().mockResolvedValue({ event_id: '$sent' }),
    prepare: () => { sync = 'PREPARED'; bus.emit('sync', sync); },
  });
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { membership = 'invite'; memberContent = undefined; client = fake(); sdk.client = client; session = undefined; });
afterEach(async () => { await session?.stop(); vi.useRealTimers(); });
async function joined() { session = await createAgentMatrixSession(creds); await session.join('!r:hs'); return session; }
const timeline = (e: ReturnType<typeof event>, liveEvent = true, toStart = false) => client.emit('timeline', e, client.room, toStart, false, { liveEvent });

describe('C11 Node Matrix session', () => {
  it('bootstraps fresh cross-signing and invokes the null-auth callback', async () => {
    client.crypto.isCrossSigningReady.mockResolvedValue(false);
    const log = vi.fn(); session = await createAgentMatrixSession(creds, { log });
    expect(client.crypto.bootstrapCrossSigning).toHaveBeenCalledOnce(); expect(client.auth).toHaveBeenCalledWith(null);
    expect(log).toHaveBeenCalledWith('cross_signing=bootstrapped');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret');
  });
  it.each([[true, false, 'already_ready'], [false, true, 'unavailable_existing_identity']])('handles existing cross-signing (%s, %s)', async (ready, keys, outcome) => {
    client.crypto.isCrossSigningReady.mockResolvedValue(ready); client.crypto.userHasCrossSigningKeys.mockResolvedValue(keys);
    const log = vi.fn(); session = await createAgentMatrixSession(creds, { log });
    expect(client.crypto.bootstrapCrossSigning).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledWith(`cross_signing=${outcome}`);
  });
  it('uses in-memory rust crypto and waits for first sync', async () => {
    client.startClient.mockImplementation(async () => {});
    let resolved = false; const pending = createAgentMatrixSession(creds).then(s => { session = s; resolved = true; });
    await flush(); await flush();
    expect(client.initRustCrypto).toHaveBeenCalledWith({ useIndexedDB: false }); expect(resolved).toBe(false);
    client.prepare(); await pending;
  });
  it('times out startup and stops the client', async () => {
    vi.useFakeTimers(); client.startClient.mockImplementation(async () => {});
    const pending = createAgentMatrixSession(creds); const assertion = expect(pending).rejects.toThrow('sync_timeout');
    await vi.advanceTimersByTimeAsync(30_000); await assertion; expect(client.stopClient).toHaveBeenCalledOnce(); expect(client.listenerCount('timeline')).toBe(0);
  });
  it('rejects unsynced invites and supports immediate and pending invite waits', async () => {
    session = await createAgentMatrixSession(creds); membership = 'leave';
    await expect(session.join('!r:hs')).rejects.toThrow('not_invited'); expect(client.joinRoom).not.toHaveBeenCalled();
    const waiting = session.waitForInvite('!r:hs', 1000); membership = 'invite'; client.emit('membership', client.room, 'invite'); await waiting;
    await session.waitForInvite('!r:hs', 1000);
  });
  it('waits for a newly invited room to be stored after its membership event', async () => {
    session = await createAgentMatrixSession(creds); membership = 'leave';
    let stored = false;
    client.getRoom.mockImplementation(() => stored ? client.room : undefined as never);
    const waiting = session.waitForInvite('!r:hs', 1000);
    membership = 'invite'; client.emit('membership', client.room, 'invite');
    stored = true; client.emit('room', client.room);
    await waiting;
    expect(client.listenerCount('membership')).toBe(0); expect(client.listenerCount('room')).toBe(0);
  });
  it('times out invite waits and cancels waits on stop', async () => {
    vi.useFakeTimers(); session = await createAgentMatrixSession(creds); membership = 'leave';
    const timeout = expect(session.waitForInvite('!r:hs', 10)).rejects.toThrow('invite_timeout'); await vi.advanceTimersByTimeAsync(10); await timeout;
    const stopped = expect(session.waitForInvite('!r:hs', 1000)).rejects.toThrow('session_stopped'); await session.stop(); await stopped; expect(client.listenerCount('membership')).toBe(0);
  });
  it('waits for delayed join sync and accepts an already joined room', async () => {
    session = await createAgentMatrixSession(creds);
    client.joinRoom.mockImplementation(async () => client.room);
    let done = false; const pending = session.join('!r:hs').then(() => { done = true; });
    await flush(); expect(done).toBe(false);
    membership = 'join'; client.emit('membership', client.room, 'join'); await pending;
    await session.join('!r:hs'); expect(client.joinRoom).toHaveBeenCalledOnce();
  });
  it('times out delayed join sync and cancels it on stop', async () => {
    vi.useFakeTimers(); session = await createAgentMatrixSession(creds);
    client.joinRoom.mockImplementation(async () => client.room);
    const timeout = expect(session.join('!r:hs')).rejects.toThrow('join_timeout');
    await vi.advanceTimersByTimeAsync(30_000); await timeout;
    const stopped = expect(session.join('!r:hs')).rejects.toThrow('session_stopped');
    await flush(); await session.stop(); await stopped;
  });
  it('deduplicates Timeline/Decrypted and excludes self, backfill and pre-join events', async () => {
    const s = await joined(); const handler = vi.fn(); s.onMessage(handler);
    const e = event(); timeline(e); client.emit('decrypted', e); timeline(e);
    timeline(event('$own', creds.userId)); timeline(event('$old', '@human:hs', 99));
    const backfill = event('$backfill'); timeline(backfill, false); client.emit('decrypted', backfill);
    timeline(event('$start'), true, true); await flush();
    expect(handler).toHaveBeenCalledOnce(); expect(handler.mock.calls[0]?.[0].eventId).toBe('$one');
  });
  it('holds live events until join cutoff is known and supports late key decryption', async () => {
    session = await createAgentMatrixSession(creds); const handler = vi.fn(); session.onMessage(handler);
    timeline(event('$old', '@human:hs', 99)); const e = event('$late'); timeline(e); await flush(); expect(handler).not.toHaveBeenCalled();
    await session.join('!r:hs'); expect(handler).toHaveBeenCalledOnce();
    let failed = true; const encrypted = { ...event('$encrypted'), isDecryptionFailure: () => failed };
    timeline(encrypted); await flush(); expect(handler).toHaveBeenCalledOnce(); failed = false; client.emit('decrypted', encrypted); expect(handler).toHaveBeenCalledTimes(2);
  });
  it('passes channel events with their full content and optional body', async () => {
    const s = await joined(); const handler = vi.fn(); const unsubscribe = s.onMessage(handler);
    const content = { body: 'AIUR-1 CI failed', kind: 'ci' }; timeline(event('$channel', '@human:hs', 100, 'com.khala.event.v1', content)); await flush();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ type: 'com.khala.event.v1', body: content.body, content });
    timeline(event('$empty', '@human:hs', 100, 'com.khala.event.v1', { kind: 'ci' })); await flush(); expect(handler.mock.calls[1]?.[0].body).toBe('');
    unsubscribe(); timeline(event('$unsub')); await flush(); expect(handler).toHaveBeenCalledTimes(2);
  });
  it('omits undecryptable history, keeps self and paginates newest-last', async () => {
    const log = vi.fn(); session = await createAgentMatrixSession(creds, { log });
    client.createMessagesRequest.mockResolvedValue({ chunk: [event('$new', creds.userId, 300), event('$bad', '@human:hs', 200, 'm.room.encrypted', {}, true), event('$old', '@human:hs', 100)] as never[], end: 'more' as never });
    const page = await session.history('!r:hs', 3, '$before');
    expect(page.messages.map(m => m.eventId)).toEqual(['$old', '$new']); expect(page.nextBefore).toBe('$old'); expect(log).toHaveBeenCalledWith('history_undecryptable=1');
    expect(client.http.authedRequest).toHaveBeenCalledWith('GET', '/rooms/!r%3Ahs/context/%24before', { limit: '0' });
    expect(client.createMessagesRequest).toHaveBeenCalledWith('!r:hs', 'cursor', 3, 'b');
    client.createMessagesRequest.mockResolvedValue({ chunk: [event()] as never[], end: undefined });
    expect((await session.history('!r:hs', 3)).nextBefore).toBeUndefined(); expect(client.createMessagesRequest).toHaveBeenLastCalledWith('!r:hs', null, 3, 'b');
  });
  it('reads member display names only after joining, with no fallback or network', async () => {
    session = await createAgentMatrixSession(creds); memberContent = { displayname: 'Maya' }; expect(session.displayName('@human:hs')).toBeUndefined();
    await session.join('!r:hs'); expect(session.displayName('@human:hs')).toBe('Maya');
    for (const content of [{}, { displayname: '' }, undefined]) { memberContent = content; expect(session.displayName('@human:hs')).toBeUndefined(); }
    expect(client.http.authedRequest).not.toHaveBeenCalled(); expect(session.roomName('!r:hs')).toBe('Channel');
  });
  it('sends text and channel events, stops idempotently and exports only C11', async () => {
    const s = await joined(); expect(await s.send('!r:hs', 'hello')).toEqual({ eventId: '$sent' });
    const content = { v: 1, kind: 'ci.passed', summary: 'CI passed', body: 'CI passed' };
    expect(await s.sendChannelEvent('!r:hs', content, 'khev-123')).toEqual({ eventId: '$event' });
    expect(client.sendEvent).toHaveBeenCalledWith('!r:hs', 'com.khala.event.v1', content, 'khev-123');
    await s.sendChannelEvent('!r:hs', content);
    expect(client.sendEvent).toHaveBeenLastCalledWith('!r:hs', 'com.khala.event.v1', content, undefined);
    await s.stop(); await s.stop(); expect(client.stopClient).toHaveBeenCalledOnce(); expect(client.eventNames()).toEqual([]);
    expect(Object.keys(await import('./session'))).toEqual(['createAgentMatrixSession']);
  });
});

it('captures the inviter before joining and preserves own member content when echoing mode', async () => {
  const s = await joined(); expect(s.inviter('!r:hs')).toBe('@owner:hs');
  await s.publishListeningMode('!r:hs', 'async');
  expect(client.sendStateEvent).toHaveBeenCalledWith('!r:hs', 'm.room.member', {
    membership: 'join', displayname: 'Agent', avatar_url: 'mxc://hs/avatar', 'com.khala.listening_mode': 'async',
  }, creds.userId, { localTimeoutMs: 5000 });
});
it('has no inviter for an already joined membership', async () => {
  membership = 'join'; const s = await joined(); expect(s.inviter('!r:hs')).toBeUndefined();
});
it('routes live mode commands separately with cutoff, deduplication and decryption', async () => {
  const s = await joined(); const commands = vi.fn(); const messages = vi.fn();
  const unsubscribe = s.onListeningModeCommand(commands); s.onMessage(messages);
  const content = { v: 1, agent: creds.userId, mode: 'async' };
  timeline(event('$old', '@owner:hs', 99, 'com.khala.listening_mode.v1', content));
  timeline(event('$history', '@owner:hs', 101, 'com.khala.listening_mode.v1', content), false);
  let type = 'm.room.encrypted';
  const encrypted = { ...event('$mode', '@owner:hs', 101, 'com.khala.listening_mode.v1', content), getType: () => type };
  timeline(encrypted); await flush(); expect(commands).not.toHaveBeenCalled();
  type = 'com.khala.listening_mode.v1'; client.emit('decrypted', encrypted); client.emit('decrypted', encrypted);
  expect(commands).toHaveBeenCalledExactlyOnceWith({ eventId: '$mode', roomId: '!r:hs', sender: '@owner:hs', ts: 101, content });
  expect(messages).not.toHaveBeenCalled();
  unsubscribe(); timeline(event('$next', '@owner:hs', 102, type, content)); await flush(); expect(commands).toHaveBeenCalledTimes(1);
});

it('restores member mode and owner on a resumed account, with one rejoin event', async () => {
  membership = 'join';
  client.room.currentState.getStateEvents.mockImplementation(() => event('$join', creds.userId, 100, 'm.room.member', {
    membership: 'join', displayname: 'Reviewer', 'com.khala.listening_mode': 'async', 'com.khala.invited_by': '@owner:hs',
  }));
  session = await createAgentMatrixSession(creds);
  await session.join('!r:hs');
  await session.join('!r:hs');
  expect(session.listeningMode?.('!r:hs')).toBe('async');
  expect(session.inviter('!r:hs')).toBe('@owner:hs');
  expect(client.joinRoom).not.toHaveBeenCalled();
  expect(client.sendEvent).toHaveBeenCalledExactlyOnceWith('!r:hs', 'com.khala.event.v1', expect.objectContaining({ summary: 'Reviewer rejoined' }), `khala.rejoin.${creds.deviceId}`);
});
