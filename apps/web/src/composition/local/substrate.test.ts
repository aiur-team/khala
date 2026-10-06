import { assertHarnessWireSupport } from './fixtures/wire-harness';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_OWNER_DEVICE_ID, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type LocalEvent, type LocalMember } from '@khala/contracts/m1/local';
import { decodeContentLimits, type RoomId } from '@khala/contracts/messaging/index';
import type { Decoded } from '@khala/contracts/messaging/decode';
import { createMemoryChannelJournal, type ChannelEntriesView, type SubstrateUpdate } from '@khala/messaging/channels/index';
import { createLocalChannelService } from './channel-service';
import { createLocalSession, LOCAL_PRINCIPAL } from './session';
import { localChannelPath, localRoomPath, type LocalHttp, type LocalHttpResult } from './http';
import { createLocalSubstrate } from './substrate';
import type { LocalMembersCache } from './types';

const decoded = decodeContentLimits({ maxBodyBytes: 8000, maxDisplayNameBytes: 64, maxRoomTitleBytes: 64 });
if (!decoded.ok) throw new Error('limits');
const limits = decoded.value;
const roomId = '!abcdefghijklmnopqrstuv:local' as RoomId;
const agent = '@agent-b2c3d4e5:local';
const eventId = (seq: number) => `$${String(seq).padStart(22, '0')}`;
const event = (seq: number, override: Partial<LocalEvent> = {}): LocalEvent => ({ seq, eventId: eventId(seq), roomId, type: 'm.room.message', sender: LOCAL_OWNER_USER_ID, ts: 1759395700000 + seq, content: { msgtype: 'm.text', body: `message ${seq}` }, ...override });
const summary = { roomId, name: 'Channel', createdAt: '2026-10-02T00:00:00.000Z', lastSeq: 5, lastTs: 0, preview: null, members: [] };
function fixture() {
  const calls: { method: string; path: string; body?: unknown; signal?: AbortSignal | undefined; timeoutMs?: number | undefined }[] = [];
  const replies = new Map<string, (LocalHttpResult<unknown> | Promise<LocalHttpResult<unknown>>)[]>();
  const enqueue = (path: string, value: LocalHttpResult<unknown> | Promise<LocalHttpResult<unknown>>) => replies.set(path, [...(replies.get(path) ?? []), value]);
  async function call<T>(method: string, path: string, decode: (value: unknown) => Decoded<T>, body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<LocalHttpResult<T>> {
    if (method === 'GET') assertHarnessWireSupport(path, decode);
    calls.push({ method, path, body, signal, timeoutMs });
    const result = await (replies.get(path)?.shift() ?? new Promise<LocalHttpResult<unknown>>(() => {}));
    if (result.kind !== 'ok') return result;
    const parsed = decode(result.value);
    if (!parsed.ok) throw new Error(`invalid fixture ${path}: ${JSON.stringify(parsed)}`);
    return { kind: 'ok', value: parsed.value };
  }
  const http: LocalHttp = { origin: 'http://localhost', get: (path, decode, signal, timeout) => call('GET', path, decode, undefined, signal, timeout), send: (method, path, body, decode, signal, timeout) => call(method, path, decode, body, signal, timeout) };
  const members: LocalMember[] = [{ userId: LOCAL_OWNER_USER_ID, participantId: LOCAL_OWNER_USER_ID, ownerId: LOCAL_OWNER_ID, deviceId: LOCAL_OWNER_DEVICE_ID, displayName: 'Owner', kind: 'human', membership: 'join' },
    { userId: agent, participantId: agent, ownerId: LOCAL_OWNER_ID, deviceId: 'KH_LOCAL_b2c3d4e5', displayName: 'kevin-Codex', kind: 'agent', membership: 'join' }];
  const cache: LocalMembersCache = { members: () => members, describe: () => undefined, subscribe: () => () => {}, refresh: vi.fn(async () => {}) };
  const sleep = vi.fn(async (ms: number, signal: AbortSignal) => { void ms; void signal; });
  const substrate = createLocalSubstrate({ http, members: cache, limits, generation: () => 1, sleep, now: () => new Date('2026-10-02T00:00:00Z') });
  const init = (events: LocalEvent[] = []) => { enqueue(localChannelPath(roomId), { kind: 'ok', value: summary }); enqueue(localRoomPath(roomId, '/messages?limit=50'), { kind: 'ok', value: { events } }); };
  return { calls, enqueue, http, cache, sleep, substrate, init };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const poll = (after: number) => localRoomPath(roomId, `/events?after=${after}&wait=25&prev=1`);
const error = (status: number): LocalHttpResult<never> => ({ kind: 'error', status, code: `http_${status}` });

describe('local substrate', () => {
  it.each([false, true])('resolves new-member attribution before publishing (dispose=%s)', async disposeEarly => {
    const f = fixture(); f.init();
    const allMembers = f.cache.members(roomId)!;
    let refreshed = false;
    f.cache.members = () => refreshed ? allMembers : allMembers.slice(0, 1);
    let finishRefresh!: () => void;
    f.cache.refresh = vi.fn(() => new Promise<void>(resolve => { finishRefresh = () => { refreshed = true; resolve(); }; }));
    f.enqueue(poll(5), { kind: 'ok', value: { events: [
      event(6, { type: 'm.room.member', sender: agent, content: { user: agent, membership: 'join', displayname: 'kevin-Codex', kind: 'agent' } }),
      event(7, { sender: agent }),
    ], next: 7 } });
    const updates: SubstrateUpdate[] = [];
    const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
    expect(f.cache.refresh).toHaveBeenCalledExactlyOnceWith(roomId);
    expect(updates).toHaveLength(1);
    if (disposeEarly) stop();
    finishRefresh(); await tick();
    if (disposeEarly) {
      expect(updates).toHaveLength(1);
      expect(f.calls.some(call => call.path === poll(7))).toBe(false);
    } else {
      expect(updates.at(-1)?.events).toMatchObject([{ participant: { displayName: 'kevin-Codex' }, authorDeviceId: 'KH_LOCAL_b2c3d4e5' }]);
      expect(f.calls.at(-1)?.path).toBe(poll(7));
      stop();
    }
  });
  it('returns transport ids for successful sends and channel creation', async () => {
    const f = fixture();
    f.enqueue(localRoomPath(roomId, '/send'), { kind: 'ok', value: { eventId: eventId(1) } });
    expect(await f.substrate.sendEvent({ roomId, clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hi' } })).toEqual({ kind: 'done', value: { eventId: eventId(1), authorDeviceId: LOCAL_OWNER_DEVICE_ID } });
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: localRoomPath(roomId, '/send'), body: { txnId: 'txn_1', type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } } });
    f.enqueue('/api/local/channels', { kind: 'ok', value: { roomId, name: 'New', selfLink: `http://localhost/join/${'a'.repeat(43)}`, shareLink: `http://localhost/join/${'b'.repeat(43)}`, openUrl: `http://localhost/open/${'c'.repeat(43)}`, expiresAt: '2026-10-02T00:00:00.000Z' } });
    expect(await f.substrate.createRoom({ operationId: 'op', title: 'New' })).toEqual({ kind: 'done', value: { roomId, title: 'New', membership: 'joined', revision: `local:${roomId}:created` } });
  });
  it('projects messages even when optional member attribution refresh fails', async () => {
    const f = fixture(); f.cache.members = () => undefined; f.cache.refresh = vi.fn(async () => { throw new Error('offline'); });
    f.enqueue(localRoomPath(roomId, '/messages?limit=50'), { kind: 'ok', value: { events: [event(1, { sender: agent })] } });
    expect(await f.substrate.timeline({ roomId, cursor: null, limit: 50 })).toMatchObject({ kind: 'done', value: { events: [{ participant: { displayName: 'agent-b2c3d4e5' } }] } });
    f.init([event(4, { sender: agent })]); const updates: SubstrateUpdate[] = [];
    const stop = f.substrate.subscribe(roomId, value => updates.push(value)); await tick();
    expect(updates[0]?.events).toHaveLength(1); stop();
  });
  it('reads the generation when publishing and bounds its replacement window', async () => {
    const f = fixture(); f.init(); let generation = 1;
    const substrate = createLocalSubstrate({ http: f.http, members: f.cache, limits, generation: () => generation, sleep: f.sleep });
    let resolve!: (value: LocalHttpResult<unknown>) => void;
    f.enqueue(poll(5), new Promise(value => { resolve = value; }));
    const updates: SubstrateUpdate[] = []; const stop = substrate.subscribe(roomId, value => updates.push(value)); await tick();
    generation = 2;
    f.enqueue(poll(205), { kind: 'ok', value: { events: [event(206)], next: 206 } });
    resolve({ kind: 'ok', value: { events: Array.from({ length: 200 }, (_, i) => event(i + 6)), next: 205 } }); await tick();
    expect(updates.at(-1)?.generation).toBe(2); expect(updates.at(-1)?.events).toHaveLength(200);
    expect(updates.at(-1)?.events[0]?.eventId).toBe(eventId(7)); stop();
  });
  it('retries initialization with backoff and cancels the default timer on dispose', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.enqueue(localChannelPath(roomId), { kind: 'unavailable' }); f.init([event(4)]);
      const substrate = createLocalSubstrate({ http: f.http, members: f.cache, limits, generation: () => 1 });
      const updates: SubstrateUpdate[] = []; const stop = substrate.subscribe(roomId, value => updates.push(value)); await tick();
      expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(1000); expect(updates[0]?.events).toHaveLength(1); stop();
      const second = fixture(); second.enqueue(localChannelPath(roomId), { kind: 'unavailable' });
      const stopSecond = createLocalSubstrate({ http: second.http, members: second.cache, limits, generation: () => 1 }).subscribe(roomId, () => {}); await tick();
      expect(vi.getTimerCount()).toBe(1); stopSecond(); await tick(); expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000); expect(second.calls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('publishes a replacement window, member joins, agent messages, and ignored events', async () => {
    const f = fixture(); f.init([event(3), event(4)]);
    f.enqueue(poll(5), { kind: 'ok', value: { events: [event(6, { type: 'm.room.member', sender: agent, content: { user: agent, membership: 'join', displayname: 'kevin-Codex', kind: 'agent' } }),
      event(7, { type: 'com.khala.event.v1', content: { v: 1, kind: 'member', summary: 'kevin-Codex joined', status: 'info', source: { system: 'khala-local' }, body: 'kevin-Codex joined' } }), event(8, { sender: agent, txnId: 'agent-txn' })], next: 8 } });
    f.enqueue(poll(8), { kind: 'ok', value: { events: [event(9, { type: 'com.khala.event.v1', content: {} })], next: 9 } });
    const updates: SubstrateUpdate[] = []; const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
    expect(updates[0]).toMatchObject({ room: { revision: 'local:5' }, events: [{}, {}] });
    expect(updates[1]).toMatchObject({ generation: 1, room: { revision: 'local:8' } });
    expect(updates[1]!.events).toHaveLength(4);
    expect(updates[1]!.events[2]).toMatchObject({ kind: 'channel_event', participant: { participantId: LOCAL_OWNER_USER_ID }, content: { summary: 'kevin-Codex joined' } });
    expect(updates[1]!.events[3]).toMatchObject({ clientTxnId: null });
    expect(updates[2]!.ignoredEventIds).toEqual([eventId(9)]);
    expect(f.cache.refresh).toHaveBeenCalledExactlyOnceWith(roomId);
    expect(f.calls.find(call => call.path === poll(8))?.timeoutMs).toBe(35_000); stop();
  });
  describe('member name changes', () => {
    const codex = { user: agent, membership: 'join', displayname: 'kevin-Codex', kind: 'agent' };
    const renamed = (seq: number, user: string, from: string, to: string, kind = 'agent') => event(seq, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
      content: { ...codex, user, kind, displayname: to }, previousContent: { ...codex, user, kind, displayname: from } } as Partial<LocalEvent>);
    const pills = (update: SubstrateUpdate | undefined) => update?.events.flatMap(e => e.kind === 'channel_event' ? [e.content.summary] : []);

    it('shows a roster rename as a pill without a reload', async () => {
      const f = fixture(); f.init([event(3)]);
      f.enqueue(poll(5), { kind: 'ok', value: { events: [renamed(6, agent, 'kevin-Codex', 'review-bot')], next: 6 } });
      const updates: SubstrateUpdate[] = []; const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
      expect(pills(updates.at(-1))).toEqual(['kevin-Codex is now review-bot']);
      stop();
    });
    it('shows one pill per agent when an owner username cascades', async () => {
      const f = fixture(); f.init();
      const other = '@agent-c3d4e5f6:local';
      f.enqueue(poll(5), { kind: 'ok', value: { events: [
        renamed(6, LOCAL_OWNER_USER_ID, 'kevin', 'ada', 'human'), renamed(7, agent, 'kevin-Codex', 'ada-Codex'), renamed(8, other, 'kevin-Claude', 'ada-Claude'),
      ], next: 8 } });
      const updates: SubstrateUpdate[] = []; const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
      expect(pills(updates.at(-1))).toEqual(['kevin is now ada', 'kevin-Codex is now ada-Codex', 'kevin-Claude is now ada-Claude']);
      stop();
    });
    it('ignores membership events that are not renames', async () => {
      const f = fixture(); f.init();
      f.enqueue(poll(5), { kind: 'ok', value: { events: [
        event(6, { type: 'm.room.member', sender: agent, content: codex, previousContent: { ...codex, membership: 'invite' } } as Partial<LocalEvent>),
        event(7, { type: 'm.room.member', sender: agent, content: codex }),
      ], next: 7 } });
      const updates: SubstrateUpdate[] = []; const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
      expect(pills(updates.at(-1))).toEqual([]);
      stop();
    });
    it('shows the same single pill after a reload', async () => {
      const f = fixture();
      const live = renamed(6, agent, 'kevin-Codex', 'review-bot');
      f.init(); f.enqueue(poll(5), { kind: 'ok', value: { events: [live], next: 6 } });
      const first: SubstrateUpdate[] = []; const stop = f.substrate.subscribe(roomId, update => first.push(update)); await tick(); stop();
      // The helper's history derives the same event id as a com.khala.event.v1 pill.
      const { previousContent: _previous, ...rest } = live;
      void _previous;
      const history: LocalEvent = { ...rest, type: 'com.khala.event.v1', content: { v: 1, kind: 'member', summary: 'kevin-Codex is now review-bot', status: 'info', source: { system: 'khala' }, body: 'kevin-Codex is now review-bot' } };
      const g = fixture(); g.init([history]);
      const second: SubstrateUpdate[] = []; const stopAgain = g.substrate.subscribe(roomId, update => second.push(update)); await tick(); stopAgain();
      expect(pills(first.at(-1))).toEqual(['kevin-Codex is now review-bot']);
      expect(pills(second.at(-1))).toEqual(['kevin-Codex is now review-bot']);
      expect(first.at(-1)!.events[0]!.eventId).toBe(second.at(-1)!.events[0]!.eventId);
    });
  });
  it('pages with opaque cursors and projects legacy names and unknown senders', async () => {
    const f = fixture();
    const notices = [event(1, { content: { msgtype: 'm.notice', body: 'Reviewer', 'com.khala.agent_participant_id': agent } }), event(2, { content: { msgtype: 'm.notice', body: 'Reviewer', 'com.khala.agent_participant_id': agent, 'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': null } }), event(3, { sender: '@agent-ffffffff:local' })];
    f.enqueue(localRoomPath(roomId, '/messages?limit=50'), { kind: 'ok', value: { events: notices, nextBefore: eventId(1) } });
    const first = await f.substrate.timeline({ roomId, cursor: null, limit: 50 });
    expect(first).toMatchObject({ kind: 'done', value: { nextCursor: eventId(1), events: [
      { content: { kind: 'agent_rename' }, targetParticipant: { participantId: agent } }, { content: { kind: 'agent_name_snapshot' }, targetParticipant: { participantId: agent } },
      { participant: { displayName: 'agent-ffffffff' }, authorDeviceId: 'KH_LOCAL_UNKNOWN' }] } });
    const path = localRoomPath(roomId, `/messages?limit=100&before=%24${eventId(1).slice(1)}`);
    f.enqueue(path, { kind: 'ok', value: { events: [] } });
    expect(await f.substrate.timeline({ roomId, cursor: eventId(1), limit: 200 })).toMatchObject({ kind: 'done', value: { nextCursor: null } });
    expect(f.calls.at(-1)?.path).toBe(path);
  });
  it('creates default names and reconciles definite absence and found channels', async () => {
    const f = fixture(); f.enqueue('/api/local/channels', error(400));
    expect(await f.substrate.createRoom({ operationId: 'op-1', title: null })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(f.calls[0]!.body).toEqual({ name: 'local-2026-10-02', operationId: 'op-1' });
    f.enqueue('/api/local/channels', { kind: 'unavailable' }); expect(await f.substrate.createRoom({ operationId: 'op-1', title: null })).toEqual({ kind: 'unknown' });
    f.enqueue('/api/local/channels/by-operation/op-1', error(404)); expect(await f.substrate.findCreatedRoom({ operationId: 'op-1' })).toEqual({ kind: 'absent' });
    f.enqueue('/api/local/channels/by-operation/op-1', { kind: 'ok', value: { roomId } }); f.enqueue(localChannelPath(roomId), { kind: 'ok', value: summary });
    expect(await f.substrate.findCreatedRoom({ operationId: 'op-1' })).toMatchObject({ kind: 'found', room: { membership: 'joined' } });
  });
  it.each([[413, 'rejected', 'too_large'], [403, 'rejected', 'forbidden'], [401, 'unavailable', undefined], [500, 'unknown', undefined], [0, 'unknown', undefined]])('maps send failure %s', async (status, kind, code) => {
    const f = fixture(); f.enqueue(localRoomPath(roomId, '/send'), status ? error(status as number) : { kind: 'unavailable' });
    expect(await f.substrate.sendEvent({ roomId, clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hi' } })).toEqual({ kind, ...(code ? { code } : {}) });
  });
  it('aborts an outstanding poll and makes no calls after disposal', async () => {
    const f = fixture(); f.init(); const updates: SubstrateUpdate[] = [];
    const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
    const pending = f.calls.at(-1)!; expect(pending.path).toBe(poll(5)); stop(); expect(pending.signal?.aborted).toBe(true);
    await tick(); expect(f.calls.at(-1)).toBe(pending);
  });
  it.each([[404, 'left'], [403, 'revoked']])('stops polls after %s', async (status, membership) => {
    const f = fixture(); f.init(); f.enqueue(poll(5), error(status as number)); const updates: SubstrateUpdate[] = [];
    const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
    expect(updates.at(-1)?.room?.membership).toBe(membership); expect(f.calls.filter(call => call.path === poll(5))).toHaveLength(1); stop();
  });
  it('backs off transport failures and resumes', async () => {
    const f = fixture(); f.init(); for (let i = 0; i < 3; i++) f.enqueue(poll(5), { kind: 'unavailable' });
    f.enqueue(poll(5), { kind: 'ok', value: { events: [event(6)], next: 6 } });
    const updates: SubstrateUpdate[] = []; const stop = f.substrate.subscribe(roomId, update => updates.push(update)); await tick();
    expect(f.sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000]); expect(updates.at(-1)?.events).toHaveLength(1); stop();
  });
  it('removes an uncertain pending send when the owner echo carries its transaction id', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const f = fixture(); f.init(); f.enqueue(localChannelPath(roomId), { kind: 'ok', value: summary });
    let resolve!: (value: LocalHttpResult<unknown>) => void; f.enqueue(poll(5), new Promise(value => { resolve = value; }));
    const session = createLocalSession(f.http); session.noteUsername('kevin'); await session.device.ensureReady(LOCAL_PRINCIPAL.ownerId);
    const service = createLocalChannelService({ principal: LOCAL_PRINCIPAL, actor: session.participant, device: session.device, substrate: f.substrate, limits, journal: () => createMemoryChannelJournal() });
    const views: ChannelEntriesView[] = []; const stop = service.room.observeEntries(roomId, value => views.push(value)); await tick();
    f.enqueue(localRoomPath(roomId, '/send'), { kind: 'unavailable' });
    expect(await service.room.send({ roomId, clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hi' } })).toMatchObject({ kind: 'outcome_unknown', operationId: 'txn_1' });
    expect(f.calls.at(-1)?.body).toEqual({ txnId: 'txn_1', type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } });
    await vi.waitFor(() => expect(views.at(-1)?.entries.some(entry => entry.kind === 'local')).toBe(true));
    resolve({ kind: 'ok', value: { events: [event(9, { txnId: 'txn_1', content: { msgtype: 'm.text', body: 'hi' } })], next: 9 } });
    await vi.waitFor(() => expect(views.at(-1)?.entries[0]?.kind).toBe('message'));
    expect(views.at(-1)?.entries).toHaveLength(1);
    expect(views.at(-1)?.entries[0]).toMatchObject({ kind: 'message', item: { ref: { eventId: eventId(9) } } });
    expect(views.at(-1)?.entries.some(entry => entry.kind === 'local')).toBe(false); stop(); service.dispose(); vi.unstubAllGlobals();
  });
});
