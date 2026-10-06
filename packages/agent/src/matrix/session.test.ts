import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMatrixSession } from './session';

const sdk = vi.hoisted(() => ({ client: undefined as unknown, store: undefined as unknown }));
vi.mock('./crypto-store', () => ({ openCryptoStore: vi.fn(async () => sdk.store) }));
vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => sdk.client),
  ClientEvent: { Sync: 'sync', Room: 'room' }, RoomEvent: { Timeline: 'timeline', MyMembership: 'membership' },
  MatrixEventEvent: { Decrypted: 'decrypted' }, SyncState: { Prepared: 'PREPARED', Syncing: 'SYNCING', Error: 'ERROR', Stopped: 'STOPPED' },
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
    stopClient: vi.fn(() => { sync = 'STOPPED'; bus.emit('sync', sync); }), getRoom: vi.fn(() => room),
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
  it('shows unavailable encrypted history, keeps self and paginates newest-last', async () => {
    const log = vi.fn(); session = await createAgentMatrixSession(creds, { log });
    client.createMessagesRequest.mockResolvedValue({ chunk: [event('$new', creds.userId, 300), event('$bad', '@human:hs', 200, 'm.room.encrypted', {}, true), event('$old', '@human:hs', 100)] as never[], end: 'more' as never });
    const page = await session.history('!r:hs', 3, '$before');
    expect(page.messages.map(m => m.eventId)).toEqual(['$old', '$bad', '$new']);
    expect(page.messages[1]).toMatchObject({ body: expect.stringContaining('Encrypted message unavailable'), content: { 'com.khala.unavailable': true } });
    expect(page.nextBefore).toBe('$old'); expect(log).toHaveBeenCalledWith('history_undecryptable=1');
    expect(client.http.authedRequest).toHaveBeenCalledWith('GET', '/rooms/!r%3Ahs/context/%24before', { limit: '0' });
    expect(client.createMessagesRequest).toHaveBeenCalledWith('!r:hs', 'cursor', 3, 'b');
    client.createMessagesRequest.mockResolvedValue({ chunk: [event()] as never[], end: undefined });
    expect((await session.history('!r:hs', 3)).nextBefore).toBeUndefined(); expect(client.createMessagesRequest).toHaveBeenLastCalledWith('!r:hs', null, 3, 'b');
  });
  it('paginates an entirely encrypted history page using its oldest placeholder', async () => {
    session = await createAgentMatrixSession(creds);
    client.createMessagesRequest.mockResolvedValue({ chunk: [event('$new', '@human:hs', 300, 'm.room.encrypted', {}, true), event('$old', '@human:hs', 100, 'm.room.encrypted', {}, true)] as never[], end: 'more' as never });
    const page = await session.history('!r:hs', 2);
    expect(page.messages.map(m => m.eventId)).toEqual(['$old', '$new']);
    expect(page.nextBefore).toBe('$old');
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
  expect(client.sendEvent).toHaveBeenCalledExactlyOnceWith('!r:hs', 'com.khala.event.v1', expect.objectContaining({ summary: 'Reviewer rejoined' }), expect.stringMatching(/^khala\.rejoin\./));
});

it('delivers live self profile renames once and projects membership history', async () => {
  const s = await joined(); const seen = vi.fn(); s.onMessage(seen);
  const rename = { ...event('$rename', creds.userId, 101, 'm.room.member', { membership: 'join', displayname: 'reviewer' }),
    getPrevContent: () => ({ membership: 'join', displayname: 'kevin-Codex' }) };
  timeline(rename); timeline(rename); client.emit('decrypted', rename); await flush();
  expect(seen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventId: '$rename', type: 'm.room.member',
    previousContent: { membership: 'join', displayname: 'kevin-Codex' } }));
  client.createMessagesRequest.mockResolvedValue({ chunk: [rename], end: undefined });
  expect((await s.history('!r:hs', 30)).messages).toEqual([seen.mock.calls[0]![0]]);
});

it('reads rename history from raw Matrix unsigned.prev_content', async () => {
  const { MatrixEvent } = await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
  const s = await joined();
  vi.spyOn(client, 'getEventMapper').mockReturnValue(raw => new MatrixEvent(raw as ConstructorParameters<typeof MatrixEvent>[0]));
  client.createMessagesRequest.mockResolvedValue({ chunk: [{ event_id: '$profile', room_id: '!r:hs', sender: creds.userId,
    origin_server_ts: 102, type: 'm.room.member', state_key: creds.userId,
    content: { membership: 'join', displayname: 'kev-Codex' },
    unsigned: { prev_content: { membership: 'join', displayname: 'kevin-Codex' } } }], end: undefined });
  expect((await s.history('!r:hs', 30)).messages).toEqual([expect.objectContaining({ eventId: '$profile', type: 'm.room.member',
    content: { membership: 'join', displayname: 'kev-Codex' }, previousContent: { membership: 'join', displayname: 'kevin-Codex' } })]);
});

it.each(['leave', 'ban'])('ends a joined hosted session once when membership becomes %s', async next => {
  const s = await joined(); const ended = vi.fn(); const ignored = vi.fn();
  s.onEnded!(ended); s.onEnded!(ignored)();
  membership = next;
  client.emit('membership', { ...client.room, roomId: '!other:hs' }, next, 'join');
  expect(ended).not.toHaveBeenCalled();
  client.emit('membership', client.room, next, 'join');
  client.emit('membership', client.room, next, 'join');
  expect(ended).toHaveBeenCalledExactlyOnceWith('removed');
  expect(ignored).not.toHaveBeenCalled(); expect(client.stopClient).toHaveBeenCalledOnce();
  expect(client.eventNames()).toEqual([]);
  await expect(s.send('!r:hs', 'after removal')).rejects.toThrow('session_stopped');
  await expect(s.sendChannelEvent('!r:hs', { body: 'after removal' })).rejects.toThrow('session_stopped');
  await expect(s.history('!r:hs', 30)).rejects.toThrow('session_stopped');
  await expect(s.publishListeningMode('!r:hs', 'async')).rejects.toThrow('session_stopped');
  expect(client.sendTextMessage).not.toHaveBeenCalled();
});

it('does not signal removal for invites, profile changes or explicit stop', async () => {
  session = await createAgentMatrixSession(creds); const ended = vi.fn(); session.onEnded!(ended);
  membership = 'leave'; client.emit('membership', client.room, 'leave', 'invite');
  membership = 'invite'; await session.join('!r:hs');
  client.emit('membership', client.room, 'join', 'join');
  await session.stop(); expect(ended).not.toHaveBeenCalled();
});

it.each([true, false])('checks control status after token revocation (removed=%s)', async removed => {
  const checkRemoved = vi.fn(async () => removed);
  session = await createAgentMatrixSession(creds, { checkRemoved }); await session.join('!r:hs');
  const ended = vi.fn(); session.onEnded!(ended);
  client.emit('sync', 'ERROR', 'SYNCING', { error: Object.assign(new Error('expired'), { errcode: 'M_UNKNOWN_TOKEN' }) });
  await flush(); await flush();
  expect(checkRemoved).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledExactlyOnceWith(removed ? 'removed' : 'unauthorized');
  expect(client.stopClient).toHaveBeenCalledOnce();
});

it.each([true, false])('checks removal on a forbidden bound-room send (removed=%s)', async removed => {
  const checkRemoved = vi.fn(async () => removed);
  session = await createAgentMatrixSession(creds, { checkRemoved }); await session.join('!r:hs');
  const ended = vi.fn(); session.onEnded!(ended);
  client.sendTextMessage.mockRejectedValue(Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' }));
  await expect(session.send('!r:hs', 'hello')).rejects.toThrow('forbidden');
  expect(checkRemoved).toHaveBeenCalledOnce();
  if (removed) expect(ended).toHaveBeenCalledExactlyOnceWith('removed');
  else { expect(ended).not.toHaveBeenCalled(); expect(client.stopClient).not.toHaveBeenCalled(); }
});

it('preserves revocation while a forbidden-send probe is pending', async () => {
  let resolveProbe!: (removed: boolean) => void;
  const checkRemoved = vi.fn(() => new Promise<boolean>(resolve => { resolveProbe = resolve; }));
  session = await createAgentMatrixSession(creds, { checkRemoved }); await session.join('!r:hs');
  const ended = vi.fn(); session.onEnded!(ended);
  client.sendTextMessage.mockRejectedValue(Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' }));
  const sending = expect(session.send('!r:hs', 'hello')).rejects.toThrow('forbidden');
  await flush();
  client.emit('sync', 'ERROR', 'SYNCING', { error: Object.assign(new Error('expired'), { errcode: 'M_UNKNOWN_TOKEN' }) });
  resolveProbe(false); await sending; await flush();
  expect(checkRemoved).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledExactlyOnceWith('unauthorized');
});

it('does not infer removal when the control probe is unavailable', async () => {
  session = await createAgentMatrixSession(creds, { checkRemoved: async () => { throw new Error('unavailable'); } });
  await session.join('!r:hs'); const ended = vi.fn(); session.onEnded!(ended);
  client.emit('sync', 'ERROR', 'SYNCING', { error: Object.assign(new Error('expired'), { errcode: 'M_UNKNOWN_TOKEN' }) });
  await flush(); await flush();
  expect(ended).toHaveBeenCalledExactlyOnceWith('unauthorized');
});

it('uses the removal probe for forbidden history reads', async () => {
  session = await createAgentMatrixSession(creds, { checkRemoved: async () => true });
  await session.join('!r:hs'); const ended = vi.fn(); session.onEnded!(ended);
  client.createMessagesRequest.mockRejectedValue(Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' }));
  await expect(session.history('!r:hs', 30)).rejects.toThrow('forbidden');
  expect(ended).toHaveBeenCalledExactlyOnceWith('removed');
});


it('uses persistent crypto and delivers offline messages and mode commands on restored timelines', async () => {
  const store = { prefix: 'channel-store', restored: true, joinedAt: 100,
    sync: { startup: vi.fn().mockResolvedValue(undefined) }, rememberJoin: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined), wipe: vi.fn().mockResolvedValue(undefined) };
  sdk.store = store;
  membership = 'join';
  const offline = event('$offline', '@owner:hs', 200);
  const command = event('$mode-offline', '@owner:hs', 201, 'com.khala.listening_mode.v1', { mode: 'async' });
  client.startClient.mockImplementation(async () => { timeline(offline, false); timeline(command, false); client.prepare(); });
  session = await createAgentMatrixSession(creds, { cryptoStore: { dir: '/private/channel', root: '/private' } });
  expect(client.initRustCrypto).toHaveBeenCalledWith({ useIndexedDB: true, cryptoDatabasePrefix: 'channel-store' });
  const messages = vi.fn(), modes = vi.fn(); session.onMessage(messages); session.onListeningModeCommand(modes);
  await session.join('!r:hs'); await flush();
  expect(messages).toHaveBeenCalledWith(expect.objectContaining({ eventId: '$offline' }));
  expect(modes).toHaveBeenCalledWith(expect.objectContaining({ eventId: '$mode-offline' }));
  await session.stop(); expect(store.close).toHaveBeenCalledOnce(); expect(store.wipe).not.toHaveBeenCalled();
});
it.each(['removed', 'unauthorized'] as const)('wipes persistent crypto on %s before releasing the lease', async reason => {
  const store = { prefix: 'channel-store', restored: true, joinedAt: 100,
    sync: { startup: vi.fn().mockResolvedValue(undefined) }, rememberJoin: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined), wipe: vi.fn().mockResolvedValue(undefined) };
  sdk.store = store;
  session = await createAgentMatrixSession(creds, { cryptoStore: { dir: '/private/channel', root: '/private' } });
  await session.join('!r:hs');
  if (reason === 'removed') client.emit('membership', client.room, 'leave');
  else client.emit('sync', 'ERROR', null, { error: { errcode: 'M_UNKNOWN_TOKEN' } });
  await flush(); await session.stop();
  expect(store.wipe).toHaveBeenCalledOnce(); expect(store.close).toHaveBeenCalledOnce();
  expect(store.wipe.mock.invocationCallOrder[0]).toBeLessThan(store.close.mock.invocationCallOrder[0]!);
});

it('recovers a mode command omitted from a limited sync tail before newer messages', async () => {
  sdk.store = { prefix: 'channel-store', restored: true, joinedAt: 100,
    sync: { startup: vi.fn().mockResolvedValue(undefined) }, rememberJoin: vi.fn(), close: vi.fn(), wipe: vi.fn() };
  membership = 'join';
  const command = event('$gap-mode', '@owner:hs', 120, 'com.khala.listening_mode.v1', { mode: 'async' });
  const older = event('$old', '@owner:hs', 90);
  const tail = event('$tail', '@owner:hs', 200);
  client.startClient.mockImplementation(async () => { timeline(tail, false); client.prepare(); });
  client.createMessagesRequest.mockResolvedValueOnce({ chunk: [tail], end: 'gap' })
    .mockResolvedValueOnce({ chunk: [command, older], end: 'older' });
  session = await createAgentMatrixSession(creds, { cryptoStore: { dir: '/private/channel', root: '/private' } });
  const delivered: string[] = [];
  session.onListeningModeCommand(c => delivered.push(c.eventId)); session.onMessage(m => delivered.push(m.eventId));
  await session.join('!r:hs');
  expect(delivered).toEqual(['$gap-mode', '$tail']);
  expect(client.createMessagesRequest).toHaveBeenNthCalledWith(2, '!r:hs', 'gap', 100, 'b');
});
it('uses different transaction IDs for successive rejoins on the same device', async () => {
  membership = 'join';
  session = await createAgentMatrixSession(creds); await session.join('!r:hs');
  const first = client.sendEvent.mock.calls[0]![3]; await session.stop();
  client = fake(); sdk.client = client;
  session = await createAgentMatrixSession(creds); await session.join('!r:hs');
  expect(client.sendEvent.mock.calls[0]![3]).not.toBe(first);
});


it('removes persisted credentials immediately but waits for sync completion before destroying stores', async () => {
  const store = { prefix: 'channel-store', restored: true, joinedAt: 100,
    sync: { startup: vi.fn().mockResolvedValue(undefined) }, rememberJoin: vi.fn().mockResolvedValue(undefined),
    forgetIdentity: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), wipe: vi.fn().mockResolvedValue(undefined) };
  sdk.store = store;
  session = await createAgentMatrixSession(creds, { cryptoStore: { dir: '/private/channel', root: '/private' } });
  await session.join('!r:hs');
  // Model an in-flight sync save: stopClient aborts polling but STOPPED only
  // arrives after the response currently being processed has finished saving.
  client.stopClient.mockImplementation(() => {});
  client.emit('membership', client.room, 'leave');
  await flush();
  expect(store.forgetIdentity).toHaveBeenCalledOnce();
  expect(store.wipe).not.toHaveBeenCalled();
  expect(store.close).not.toHaveBeenCalled();
  client.emit('sync', 'STOPPED');
  await session.stop();
  expect(store.wipe).toHaveBeenCalledOnce();
  expect(store.close).toHaveBeenCalledOnce();
});

it('still stops and releases the store when the first identity deletion fails', async () => {
  const store = { prefix: 'channel-store', restored: true, joinedAt: 100,
    sync: { startup: vi.fn().mockResolvedValue(undefined) }, rememberJoin: vi.fn().mockResolvedValue(undefined),
    forgetIdentity: vi.fn().mockRejectedValue(new Error('disk busy')), close: vi.fn().mockResolvedValue(undefined), wipe: vi.fn().mockResolvedValue(undefined) };
  sdk.store = store;
  session = await createAgentMatrixSession(creds, { cryptoStore: { dir: '/private/channel', root: '/private' } });
  await session.join('!r:hs');
  client.emit('membership', client.room, 'leave');
  await session.stop();
  expect(client.stopClient).toHaveBeenCalledOnce();
  expect(store.wipe).toHaveBeenCalledOnce();
  expect(store.close).toHaveBeenCalledOnce();
});
