import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import { LOCAL_OWNER_DEVICE_ID, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type LocalEvent, type LocalMemberContent } from '@khala/contracts/m1/local';
import type { HelperContext, LocalAuth, LocalRequest, LocalStore } from '../types';
import { roomRoutes } from './rooms';

const R = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
const A = '@agent-a1b2c3d4:local';
const OWNER: LocalAuth = { kind: 'owner', via: 'cookie' };
const AGENT: LocalAuth = { kind: 'agent', userId: A, roomId: R };
const invite: LocalMemberContent = { user: A, membership: 'invite', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', invitedBy: LOCAL_OWNER_USER_ID };
const text = (body: string, txnId = 'a1') => ({ txnId, type: 'm.room.message', content: { msgtype: 'm.text', body } });
const modePath = `members/${encodeURIComponent(A)}`;

function fakeStore() {
  const logs = new Map<string, LocalEvent[]>();
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const last = (r: string, u: string) => [...(logs.get(r) ?? [])].reverse().find(e => e.type === 'm.room.member' && e.content['user'] === u);
  const toMember = (event: LocalEvent) => {
    const c = event.content as LocalMemberContent;
    return { userId: c.user, participantId: c.user, ownerId: LOCAL_OWNER_ID,
      deviceId: c.kind === 'human' ? LOCAL_OWNER_DEVICE_ID : `KH_LOCAL_${c.user.slice(7, 15)}`,
      displayName: c.displayname, kind: c.kind, ...(c.harness ? { harness: c.harness } : {}),
      ...(c.kind === 'agent' ? { ownerLabel: 'kevin', listeningMode: c['com.khala.listening_mode'] ?? 'sync' } : {}), membership: c.membership };
  };
  const append = vi.fn(async (r: string, input: Parameters<LocalStore['append']>[1]) => {
    const log = logs.get(r)!;
    const duplicate = input.txnId === undefined ? undefined : log.find(e => e.sender === input.sender && e.txnId === input.txnId);
    if (duplicate) return duplicate;
    // Yield between the read and write to expose missing route serialization.
    await Promise.resolve();
    const event: LocalEvent = { ...input, seq: log.length + 1, eventId: `$${String(log.length + 1).padStart(22, '0')}`,
      roomId: r, ts: 1_759_395_600_000 + log.length };
    log.push(event);
    wake();
    return event;
  });
  const waitForEvent = vi.fn((r: string, after: number, ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); waiters.delete(check); signal.removeEventListener('abort', done); resolve(); };
    const check = () => { if (!logs.has(r) || logs.get(r)!.length > after || signal.aborted) done(); };
    const timer = setTimeout(done, ms);
    waiters.add(check);
    signal.addEventListener('abort', done);
    check();
  }));
  const used = {
    hasChannel: (r: string) => logs.has(r), channelName: () => 'refactor',
    member: (r: string, u: string) => { const event = last(r, u); return event && toMember(event); },
    members: (r: string) => [...new Set(logs.get(r)?.filter(e => e.type === 'm.room.member').map(e => e.content['user'] as string))]
      .map(u => toMember(last(r, u)!)).filter(m => m.membership !== 'leave'),
    append, waitForEvent,
    eventsAfter: (r: string, after: number, limit: number) => (logs.get(r) ?? []).filter(e => e.seq > after).slice(0, limit),
    history: (r: string, before: string | undefined, limit: number) => {
      const log = logs.get(r)!;
      const cutoff = before === undefined ? Infinity : log.find(e => e.eventId === before)?.seq ?? 0;
      const messages = log.filter(e => e.seq < cutoff && (e.type === 'm.room.message' || e.type === 'com.khala.event.v1'));
      const events = messages.slice(-limit);
      return { events, ...(messages.length > limit ? { nextBefore: events[0]!.eventId } : {}) };
    },
    async deleteChannel(r: string) { logs.delete(r); wake(); },
  };
  const unsupported = () => { throw new Error('not used'); };
  const store: LocalStore = {
    ...used, members: used.members as LocalStore['members'],
    listChannels: unsupported, channelSummary: unsupported, createChannel: unsupported, findByOperation: unsupported,
    channelOfMember: unsupported, revision: unsupported, waitForRevision: unsupported,
    mintLink: unsupported, consumeLink: unsupported, memberForSession: unsupported, setMemberToken: unsupported, agentForToken: unsupported,
    owner: unsupported, setOwner: unsupported, ownerChannelName: unsupported, setOwnerChannelName: unsupported,
  };
  return { store, logs, append, waitForEvent, waiters };
}

function fixture() {
  const fake = fakeStore();
  fake.logs.set(R, []);
  const log = fake.logs.get(R)!;
  const seed = (input: Parameters<LocalStore['append']>[1]) => {
    const event: LocalEvent = { ...input, roomId: R, seq: log.length + 1, eventId: `$${String(log.length + 1).padStart(22, '0')}`, ts: 1_759_395_600_000 + log.length };
    log.push(event);
    return event;
  };
  seed({ type: 'm.room.create', sender: LOCAL_OWNER_USER_ID, content: { name: 'refactor', createdBy: LOCAL_OWNER_USER_ID } });
  seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: 'kevin', kind: 'human' } });
  seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite } });
  const ctx: HelperContext = { store: fake.store, origin: 'http://127.0.0.1:47830', now: () => 0, random: n => new Uint8Array(n), version: 'test',
    mintOpenToken: () => ({ token: '', expiresAt: '' }), consumeOpenToken: () => null, createOwnerSession: () => '', shutdown: () => {}, joins: new Map() };
  const routes = roomRoutes();
  const call = async (method: LocalRequest['method'], tail: string, options: { auth?: LocalAuth; body?: unknown; signal?: AbortSignal; id?: string } = {}) => {
    const url = new URL(`/api/local/rooms/${encodeURIComponent(options.id ?? R)}/${tail}`, ctx.origin);
    const route = routes.find(r => r.method === method && r.pattern.test(url.pathname));
    if (!route) throw new Error('missing route');
    const params = route.pattern.exec(url.pathname)!.slice(1);
    return route.handle({ method, path: url.pathname, query: url.searchParams, headers: {}, body: options.body,
      auth: options.auth ?? AGENT, origin: ctx.origin, signal: options.signal ?? new AbortController().signal }, params, ctx);
  };
  return { ...fake, log, seed, ctx, call, routes };
}

describe('participant endpoints', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(() => { vi.useRealTimers(); });

  it('exports exactly seven routes', () => { expect(f.routes).toHaveLength(7); });

  const endpoints: [LocalRequest['method'], string][] = [['GET', 'me'], ['POST', 'join'], ['GET', 'events'], ['GET', 'messages'], ['POST', 'send'], ['GET', 'members'], ['PUT', modePath]];
  it.each(endpoints)('resolves auth and channel before membership: %s %s', async (method, path) => {
    expect(await f.call(method, path, { auth: { kind: 'none' }, id: 'missing' })).toEqual({ status: 401, json: { error: 'unauthorized' } });
    expect(await f.call(method, path, { auth: OWNER, id: 'missing' })).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(await f.call(method, path, { auth: { ...AGENT, roomId: 'other' } as LocalAuth })).toEqual({ status: 403, json: { error: 'not_member' } });
    expect(await f.call(method, path, { auth: { kind: 'agent', userId: '@agent-eeeeeeee:local', roomId: R } })).toEqual({ status: 403, json: { error: 'not_member' } });
  });

  it('reports identity, invitation and owner identity', async () => {
    expect(await f.call('GET', 'me')).toEqual({ status: 200, json: { userId: A, roomId: R, roomName: 'refactor', membership: 'invite', displayName: 'kevin-Claude', invitedBy: LOCAL_OWNER_USER_ID } });
    expect(await f.call('GET', 'me', { auth: OWNER })).toEqual({ status: 200, json: { userId: LOCAL_OWNER_USER_ID, roomId: R, roomName: 'refactor', membership: 'join', displayName: 'kevin' } });
    const me = f.routes[0]!;
    expect(await me.handle({ auth: OWNER } as LocalRequest, ['%ZZ'], f.ctx)).toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('joins once under concurrency and returns the member event cutoff', async () => {
    const joined = await Promise.all([f.call('POST', 'join', { body: {} }), f.call('POST', 'join')]);
    expect(joined[0]).toEqual({ status: 200, json: { seq: 4, ts: f.log[3]!.ts } });
    expect(joined[1]).toEqual(joined[0]);
    expect(f.log).toHaveLength(5);
    expect(f.log[3]).toMatchObject({ sender: A, type: 'm.room.member', content: { user: A, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', 'com.khala.listening_mode': 'sync' } });
    expect(f.log[4]).toMatchObject({ sender: LOCAL_OWNER_USER_ID, type: 'com.khala.event.v1', content: { v: 1, kind: 'member', summary: 'kevin-Claude joined', body: 'kevin-Claude joined', status: 'info', source: { system: 'khala-local' } } });
    expect(await f.call('POST', 'join')).toEqual(joined[0]);
    expect(await f.call('POST', 'join', { auth: OWNER })).toEqual({ status: 200, json: { seq: 2, ts: f.log[1]!.ts } });
    expect(f.log).toHaveLength(5);
  });

  it('announces one rejoin pill from join history and retains mode, adding no field to member content', async () => {
    const f = fixture();
    await f.call('POST', 'join');
    await f.store.append(R, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
      content: { ...invite, displayname: 'Helper', 'com.khala.listening_mode': 'async' } });
    await f.call('POST', 'join');
    await f.call('POST', 'join');
    expect(f.log.filter(e => e.type === 'com.khala.event.v1').map(e => e.content.summary)).toEqual(['kevin-Claude joined', 'Helper rejoined']);
    expect(f.log.at(-2)).toMatchObject({ type: 'm.room.member', content: { membership: 'join', displayname: 'Helper' } });
    expect(f.log.filter(e => e.type === 'm.room.member').every(e => !Object.hasOwn(e.content, 'com.khala.rejoin'))).toBe(true);
    expect(f.store.member(R, A)).toMatchObject({ displayName: 'Helper', listeningMode: 'async' });
  });

  it.each([null, [], { x: 1 }, ''])('rejects nonempty or nonobject join body %j', async body => {
    expect(await f.call('POST', 'join', { body })).toEqual({ status: 400, json: { error: 'invalid_request' } });
  });

  it('finds the current member event beyond one page and after mode echo', async () => {
    await f.call('POST', 'join');
    for (let i = 0; i < 220; i++) f.seed({ type: 'm.room.message', sender: LOCAL_OWNER_USER_ID, content: { msgtype: 'm.text', body: 'x' } });
    await f.call('PUT', modePath, { body: { listeningMode: 'async' } });
    const event = f.log.at(-1)!;
    expect(await f.call('POST', 'join')).toEqual({ status: 200, json: { seq: event.seq, ts: event.ts } });
    expect(f.log).toHaveLength(226);
  });

  it('streams every event in ascending capped pages without repeats across factories', async () => {
    await f.call('POST', 'join');
    expect(await f.call('GET', 'events?after=0')).toEqual({ status: 200, json: { events: f.log, next: 5 } });
    expect(await f.call('GET', 'events?after=5&wait=0')).toEqual({ status: 200, json: { events: [], next: 5 } });
    for (let i = 0; i < 250; i++) f.seed({ type: 'm.room.message', sender: A, content: { msgtype: 'm.text', body: 'x' } });
    expect(await f.call('GET', 'events')).toEqual({ status: 200, json: { events: f.log.slice(0, 200), next: 200 } });
    const route = roomRoutes().find(r => r.pattern.test(`/api/local/rooms/${R}/events`))!;
    const response = await route.handle({ auth: AGENT, query: new URLSearchParams('after=200'), signal: new AbortController().signal } as LocalRequest, [R], f.ctx);
    expect(response).toEqual({ status: 200, json: { events: f.log.slice(200), next: 255 } });
    expect(f.waitForEvent).not.toHaveBeenCalled();
  });

  it('wakes a long poll on append and passes the timeout and client signal', async () => {
    await f.call('POST', 'join');
    const controller = new AbortController();
    const pending = f.call('GET', 'events?after=5&wait=25', { signal: controller.signal });
    expect(f.waitForEvent).toHaveBeenCalledWith(R, 5, 25_000, controller.signal);
    const event = await f.store.append(R, { type: 'm.room.message', sender: LOCAL_OWNER_USER_ID, content: { msgtype: 'm.text', body: 'hi' } });
    expect(await pending).toEqual({ status: 200, json: { events: [event], next: 6 } });
    expect(f.waiters.size).toBe(0);
  });

  it('aborts a long poll promptly and skips waiting for an already aborted client', async () => {
    await f.call('POST', 'join');
    const controller = new AbortController();
    const pending = f.call('GET', 'events?after=5&wait=25', { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: 200, json: { events: [], next: 5 } });
    expect(f.waiters.size).toBe(0);
    f.waitForEvent.mockClear();
    expect(await f.call('GET', 'events?after=5&wait=25', { signal: controller.signal })).toEqual({ status: 200, json: { events: [], next: 5 } });
    expect(f.waitForEvent).not.toHaveBeenCalled();
  });

  it('times out at the requested wait', async () => {
    await f.call('POST', 'join');
    vi.useFakeTimers();
    let settled = false;
    const pending = f.call('GET', 'events?after=5&wait=1').then(response => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 200, json: { events: [], next: 5 } });
    expect(f.waiters.size).toBe(0);
  });

  it('rejects a deleted channel after polling wakes', async () => {
    await f.call('POST', 'join');
    const pending = f.call('GET', 'events?after=5&wait=25');
    await f.store.deleteChannel(R);
    expect(await pending).toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('rejects a removed participant after polling wakes', async () => {
    await f.call('POST', 'join');
    const pending = f.call('GET', 'events?after=5&wait=25');
    await f.store.append(R, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite, membership: 'leave' } });
    expect(await pending).toEqual({ status: 403, json: { error: 'not_member' } });
  });

  it.each(['after=-1', 'after=x', 'after=1.5', 'after=', 'after=1000000000000000', 'wait=26', 'wait=1.5', 'wait=-1', 'wait='])('rejects invalid polling query %s', async query => {
    expect(await f.call('GET', `events?${query}`, { auth: OWNER })).toEqual({ status: 400, json: { error: 'invalid_request' } });
  });

  it('sends text idempotently including concurrent requests, scoped to sender', async () => {
    await f.call('POST', 'join');
    const results = await Promise.all([f.call('POST', 'send', { body: text('on it') }), f.call('POST', 'send', { body: text('on it') })]);
    expect(results[0]).toEqual({ status: 200, json: { eventId: f.log[5]!.eventId } });
    expect(results[1]).toEqual(results[0]);
    expect(await f.call('POST', 'send', { body: text('changed') })).toEqual(results[0]);
    expect(f.log).toHaveLength(6);
    expect(f.log[5]).toMatchObject({ sender: A, txnId: 'a1', content: text('on it').content });
    expect(await f.call('POST', 'send', { auth: OWNER, body: text('hi') })).toEqual({ status: 200, json: { eventId: f.log[6]!.eventId } });
    expect(f.log[6]!.sender).toBe(LOCAL_OWNER_USER_ID);
    expect(await f.call('POST', 'send', { auth: { kind: 'owner', via: 'admin' }, body: text('admin', 'admin') })).toEqual({ status: 200, json: { eventId: f.log[7]!.eventId } });
    expect(f.log[7]!.sender).toBe(LOCAL_OWNER_USER_ID);
  });

  it.each([
    { ...text('x'), txnId: '' }, { ...text('x'), txnId: 'a b' }, { ...text('x'), txnId: 'x'.repeat(65) },
    { ...text('x'), type: 'm.room.name' }, { ...text('x'), content: { msgtype: 'm.image', body: 'x' } },
    text(''), text('x'.repeat(8001)), { txnId: 'a', type: 'm.room.message' }, { ...text('x'), extra: 1 },
    { ...text('x'), content: [] }, { ...text('x'), content: null }, { ...text('x'), content: { msgtype: 'm.text', body: 1 } },
    null, [],
  ])('rejects invalid sends %j', async body => {
    expect(await f.call('POST', 'send', { auth: OWNER, body })).toEqual({ status: 400, json: { error: 'invalid_request' } });
    expect(f.log).toHaveLength(3);
  });

  it('preserves notices and enforces body and UTF-8 content boundaries', async () => {
    const content = { msgtype: 'm.notice', body: 'renamed', 'com.khala.agent_participant_id': A, 'com.khala.name_snapshot': 'new name' };
    expect((await f.call('POST', 'send', { auth: OWNER, body: { txnId: 'notice', type: 'm.room.message', content } })).status).toBe(200);
    expect(f.log.at(-1)!.content).toBe(content);
    expect((await f.call('POST', 'send', { auth: OWNER, body: text('x'.repeat(8000), 'max') })).status).toBe(200);
    const oversized = { ...text('hi'), content: { msgtype: 'm.notice', body: 'hi', extra: 'é'.repeat(16_500) } };
    expect(await f.call('POST', 'send', { auth: OWNER, body: oversized })).toEqual({ status: 413, json: { error: 'payload_too_large' } });
    const base = { msgtype: 'm.notice', body: 'hi', extra: '' };
    const padding = 32_768 - Buffer.byteLength(JSON.stringify(base));
    const exact = { ...base, extra: 'x'.repeat(padding) };
    expect((await f.call('POST', 'send', { auth: OWNER, body: { txnId: 'exact', type: 'm.room.message', content: exact } })).status).toBe(200);
    expect((await f.call('POST', 'send', { auth: OWNER, body: { txnId: 'over', type: 'm.room.message', content: { ...exact, extra: exact.extra + 'x' } } })).status).toBe(413);
  });

  it('validates and normalizes channel events', async () => {
    const encoded = encodeChannelEvent({ kind: 'ci.passed', summary: 'CI green' });
    if (!encoded.ok) throw new Error('invalid fixture');
    const request = { txnId: 'ci', type: 'com.khala.event.v1', content: { ...encoded.value, unknown: 'drop me' } };
    expect((await f.call('POST', 'send', { auth: OWNER, body: request })).status).toBe(200);
    expect(f.log.at(-1)!.content).toEqual(encoded.value);
    expect(await f.call('POST', 'send', { auth: OWNER, body: { ...request, content: { v: 1, kind: 'Bad Kind', summary: 'x', body: '' } } })).toEqual({ status: 400, json: { error: 'invalid_request' } });
  });

  it('pages message history oldest first, excluding state events', async () => {
    for (let i = 0; i < 5; i++) {
      f.seed({ type: 'm.room.message', sender: LOCAL_OWNER_USER_ID, content: { msgtype: 'm.text', body: String(i) } });
      f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite } });
    }
    const messages = f.log.filter(e => e.type === 'm.room.message');
    const before = messages[3]!.eventId;
    expect(await f.call('GET', 'messages?limit=2', { auth: OWNER })).toEqual({ status: 200, json: { events: messages.slice(3), nextBefore: before } });
    expect(await f.call('GET', `messages?before=${encodeURIComponent(before)}&limit=100`, { auth: OWNER })).toEqual({ status: 200, json: { events: messages.slice(0, 3) } });
    expect(await f.call('GET', 'messages', { auth: OWNER })).toEqual({ status: 200, json: { events: messages } });
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=', 'before=abc', 'before='])('rejects invalid history query %s', async query => {
    expect(await f.call('GET', `messages?${query}`, { auth: OWNER })).toEqual({ status: 400, json: { error: 'invalid_request' } });
  });

  it('returns the roster unchanged with participant and owner identifiers', async () => {
    await f.call('POST', 'join');
    const members = f.store.members(R);
    expect(await f.call('GET', 'members')).toEqual({ status: 200, json: { members } });
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.participantId).toBe(member.userId);
      expect(member.ownerId).toBe(LOCAL_OWNER_ID);
    }
    expect(members[1]).toMatchObject({ listeningMode: 'sync', harness: 'claude', ownerLabel: 'kevin', deviceId: 'KH_LOCAL_a1b2c3d4' });
  });

  it('serializes join and echoes preserving member identity', async () => {
    await f.call('POST', 'join');
    const responses = await Promise.all(['steer', 'async', 'sync'].map(listeningMode => f.call('PUT', modePath, { body: { listeningMode } })));
    expect(responses).toEqual([{ status: 204 }, { status: 204 }, { status: 204 }]);
    expect(f.log.slice(5).map(e => e.content['com.khala.listening_mode'])).toEqual(['steer', 'async', 'sync']);
    expect(f.log.at(-1)).toMatchObject({ sender: A, type: 'm.room.member', content: { user: A, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', 'com.khala.listening_mode': 'sync' } });
    const latest = f.log.at(-1)!;
    expect(await f.call('POST', 'join')).toEqual({ status: 200, json: { seq: latest.seq, ts: latest.ts } });
  });

  it('restricts mode echoes to joined agents targeting themselves', async () => {
    expect((await f.call('PUT', modePath, { body: { listeningMode: 'steer' } })).status).toBe(403);
    await f.call('POST', 'join');
    expect(await f.call('PUT', `members/${encodeURIComponent(LOCAL_OWNER_USER_ID)}`, { body: { listeningMode: 'steer' } })).toEqual({ status: 409, json: { error: 'conflict' } });
    expect(await f.call('PUT', modePath, { auth: OWNER, body: { listeningMode: 'steer' } })).toEqual({ status: 409, json: { error: 'conflict' } });
    const route = f.routes.at(-1)!;
    expect(await route.handle({ auth: AGENT } as LocalRequest, [R, '%ZZ'], f.ctx)).toEqual({ status: 400, json: { error: 'invalid_request' } });
    for (const body of [{ listeningMode: 'loud' }, { listeningMode: 'steer', extra: true }, {}, null, []]) {
      expect(await f.call('PUT', modePath, { body })).toEqual({ status: 400, json: { error: 'invalid_request' } });
    }
  });

  it.each(endpoints.filter(([, path]) => path !== 'me'))('rejects removed agents on %s %s', async (method, path) => {
    f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite, membership: 'leave' } });
    expect(await f.call(method, path, { body: {} })).toEqual({ status: 403, json: { error: 'not_member' } });
    expect(await f.call('GET', 'me')).toMatchObject({ status: 200, json: { membership: 'leave', invitedBy: LOCAL_OWNER_USER_ID } });
  });

  it('rechecks queued mutations before appending', async () => {
    const pending = f.call('POST', 'join');
    f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite, membership: 'leave' } });
    expect(await pending).toEqual({ status: 403, json: { error: 'not_member' } });
    expect(f.append).not.toHaveBeenCalled();
    f.seed({ type: 'm.room.member', sender: A, content: { ...invite, membership: 'join' } });
    const mutations = [f.call('POST', 'send', { body: text('hi') }), f.call('PUT', modePath, { body: { listeningMode: 'steer' } })];
    f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite, membership: 'leave' } });
    expect(await Promise.all(mutations)).toEqual([{ status: 403, json: { error: 'not_member' } }, { status: 403, json: { error: 'not_member' } }]);
    expect(f.append).not.toHaveBeenCalled();
  });

  it('repairs a failed join announcement across factories without duplicating it', async () => {
    const append = f.append.getMockImplementation()!;
    f.append.mockImplementationOnce(append).mockRejectedValueOnce(new Error('announcement failure'));
    expect(await f.call('POST', 'join')).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect(f.log).toHaveLength(4);
    const own = f.log[3]!;
    // Replay a persisted log through a fresh factory, as after a helper restart.
    const route = roomRoutes().find(r => r.method === 'POST' && r.pattern.test(`/api/local/rooms/${R}/join`))!;
    const req = { auth: AGENT, body: {} } as LocalRequest;
    expect(await route.handle(req, [R], f.ctx)).toEqual({ status: 200, json: { seq: own.seq, ts: own.ts } });
    expect(f.log).toHaveLength(5);
    expect(f.log[4]).toMatchObject({ type: 'com.khala.event.v1', sender: LOCAL_OWNER_USER_ID, content: { summary: 'kevin-Claude joined' } });
    expect(await f.call('POST', 'join')).toEqual({ status: 200, json: { seq: own.seq, ts: own.ts } });
    expect(f.log).toHaveLength(5);
  });

  it('recovers the original announcement after a mode echo and announces a later rejoin separately', async () => {
    const append = f.append.getMockImplementation()!;
    f.append.mockImplementationOnce(append).mockRejectedValueOnce(new Error('announcement failure'));
    expect((await f.call('POST', 'join')).status).toBe(503);
    const original = f.log[3]!;
    await f.call('PUT', modePath, { body: { listeningMode: 'steer' } });
    const echo = f.log.at(-1)!;
    expect(await f.call('POST', 'join')).toEqual({ status: 200, json: { seq: echo.seq, ts: echo.ts } });
    const firstAnnouncement = f.log.at(-1)!;
    expect(firstAnnouncement.txnId).toBe(`local.join.${original.eventId.slice(1)}`);
    expect(firstAnnouncement.content['summary']).toBe('kevin-Claude joined');
    f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite, membership: 'leave' } });
    f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: { ...invite, displayname: 'new name' } });
    expect((await f.call('POST', 'join')).status).toBe(200);
    const secondAnnouncement = f.log.at(-1)!;
    expect(secondAnnouncement.txnId).not.toBe(firstAnnouncement.txnId);
    expect(secondAnnouncement.content['summary']).toBe('new name rejoined');
    expect(f.log.filter(e => e.type === 'com.khala.event.v1')).toHaveLength(2);
  });

  it('maps asynchronous failures to unavailable and recovers its queue', async () => {
    f.append.mockRejectedValueOnce(new Error('disk failure'));
    expect(await f.call('POST', 'join')).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect((await f.call('POST', 'join')).status).toBe(200);
    f.append.mockRejectedValueOnce(new Error('disk failure'));
    expect(await f.call('POST', 'send', { body: text('hi') })).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect((await f.call('POST', 'send', { body: text('hi') })).status).toBe(200);
    f.waitForEvent.mockRejectedValueOnce(new Error('read failure'));
    expect(await f.call('GET', 'events?after=6&wait=25')).toEqual({ status: 503, json: { error: 'unavailable' } });
  });
});

it.each(['mode', 'rename'])('keeps %s previous membership opt-in for older agent decoders', async change => {
  const f = fixture();
  await f.call('POST', 'join');
  const content = { ...invite, membership: 'join' as const, displayname: change === 'rename' ? 'reviewer' : 'kevin-Claude', 'com.khala.listening_mode': 'async' as const };
  f.seed({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content });
  const latest = f.log.at(-1)!;
  latest.previousContent = { ...content, displayname: 'kevin-Claude' };
  const plain = await f.call('GET', 'events?after=5');
  expect(JSON.stringify(plain)).not.toContain('previousContent');
  const opted = await f.call('GET', 'events?after=5&prev=1');
  expect(opted).toMatchObject({ status: 200, json: { events: [expect.objectContaining({ previousContent: latest.previousContent })] } });
  expect(latest.previousContent).toBeDefined();
});
