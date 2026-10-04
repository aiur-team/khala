import { afterEach, expect, it, vi } from 'vitest';
import { decodeAgentRenameResult } from '@khala/contracts/m1/agent-names';
import { LOCAL_OWNER_USER_ID as OWNER, type LocalEvent, type LocalMember } from '@khala/contracts/m1/local';
import { parseChannelLink } from '../../join';
import type { HelperContext, LocalAuth, LocalRequest, LocalStore } from '../types';
import { ownerRoutes, serial, type SerialQueue } from './owner';

const ADMIN: LocalAuth = { kind: 'owner', via: 'admin' };
const COOKIE: LocalAuth = { kind: 'owner', via: 'cookie' };
const A = '@agent-a1b2c3d4:local';
const B = '@agent-b1b2c3d4:local';
const EXPIRES = '2026-10-02T09:10:00.000Z';
type Member = NonNullable<ReturnType<LocalStore['member']>>;
function fixture(storeJoins = false, queue?: SerialQueue) {
  const logs = new Map<string, LocalEvent[]>();
  const operations = new Map<string, string>();
  let revision = 0;
  let counter = 0;
  const watchers = new Set<() => void>();
  const bump = () => { revision++; for (const wake of watchers) wake(); };
  const member = (id: string, user: string): Member | undefined => {
    const event = logs.get(id)?.slice().reverse().find(e => e.type === 'm.room.member' && e.content.user === user);
    if (!event) return undefined;
    const c = event.content;
    return { userId: user, participantId: user, ownerId: 'local-owner', deviceId: 'KH_LOCAL_OWNER', displayName: c.displayname as string,
      kind: c.kind as Member['kind'], membership: c.membership as Member['membership'],
      ...(c.harness ? { harness: c.harness as NonNullable<Member['harness']> } : {}),
      ...(c.kind === 'agent' ? { listeningMode: (c['com.khala.listening_mode'] ?? 'sync') as NonNullable<Member['listeningMode']> } : {}) };
  };
  const store: LocalStore = {
    memberForSession: () => undefined,
    revision: () => revision,
    hasChannel: id => logs.has(id),
    owner: () => ({ v: 1, username: 'kevin', color: 'blue', initials: 'KW', updatedAt: EXPIRES }),
    setOwner: vi.fn(),
    append: vi.fn(async (id, input) => {
      const events = logs.get(id);
      if (!events) throw new Error('missing_channel');
      const prior = input.txnId && events.find(e => e.sender === input.sender && e.txnId === input.txnId);
      if (prior) return prior;
      const event: LocalEvent = { ...input, roomId: id, seq: events.length + 1, eventId: `$${String(++counter).padStart(22, '0')}`, ts: counter };
      events.push(event); bump(); return event;
    }),
    createChannel: vi.fn(async (name, op) => {
      if (op && operations.has(op)) return { roomId: operations.get(op)!, created: false };
      const id = `!${String(++counter).padStart(22, '0')}:local`;
      logs.set(id, []); bump();
      await store.append(id, { type: 'm.room.create', sender: OWNER, content: { name, createdBy: OWNER, ...(op ? { operationId: op } : {}) } });
      if (op) operations.set(op, id);
      if (storeJoins) await store.append(id, { type: 'm.room.member', sender: OWNER, content: { user: OWNER, displayname: 'kevin', membership: 'join', kind: 'human' } });
      return { roomId: id, created: true };
    }),
    findByOperation: op => operations.get(op),
    deleteChannel: vi.fn(async id => { logs.delete(id); bump(); }),
    channelName: id => logs.get(id)![0]!.content.name as string,
    member,
    members: id => [...new Set(logs.get(id)?.filter(e => e.type === 'm.room.member').map(e => e.content.user as string))]
      .map(user => member(id, user)!).filter(m => m.membership !== 'leave') as LocalMember[],
    channelOfMember: user => [...logs.keys()].find(id => member(id, user) !== undefined),
    channelSummary: id => logs.has(id) ? { roomId: id, name: store.channelName(id), createdAt: EXPIRES, lastSeq: logs.get(id)!.length, lastTs: logs.get(id)!.at(-1)!.ts, preview: null, members: store.members(id) } : undefined,
    listChannels: () => [...logs.keys()].map(id => store.channelSummary(id)!).sort((a, b) => b.lastTs - a.lastTs),
    waitForRevision: vi.fn(async (since, ms, signal) => {
      if (revision !== since || signal.aborted) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); watchers.delete(done); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms); watchers.add(done); signal.addEventListener('abort', done, { once: true });
      });
    }),
    mintLink: vi.fn(async () => ({ token: String(++counter).padStart(43, 'L'), expiresAt: EXPIRES })),
    consumeLink: vi.fn(), setMemberToken: vi.fn(async () => { throw new Error('token_must_remain'); }), agentForToken: () => null,
    eventsAfter: () => [], waitForEvent: vi.fn(), history: () => ({ events: [] }),
  };
  const open = new Map<string, { roomId?: string }>();
  const ctx: HelperContext = {
    store, origin: 'http://127.0.0.1:47830', now: () => 0, random: n => new Uint8Array(n), version: 'test', joins: new Map(),
    mintOpenToken: vi.fn(id => { const token = String(++counter).padStart(43, 'O'); open.set(token, id === undefined ? {} : { roomId: id }); return { token, expiresAt: EXPIRES }; }),
    consumeOpenToken: vi.fn(token => { const value = open.get(token); open.delete(token); return value ?? null; }),
    createOwnerSession: vi.fn(() => 'S'.repeat(43)), shutdown: vi.fn(),
  };
  const routes = ownerRoutes(queue ? { queue } : {});
  const call = async (method: LocalRequest['method'], url: string, body?: unknown, auth = ADMIN, signal = new AbortController().signal) => {
    const parsed = new URL(url, ctx.origin);
    const route = routes.find(r => r.method === method && r.pattern.test(parsed.pathname));
    if (!route) throw new Error('route_missing');
    return route.handle({ method, path: parsed.pathname, query: parsed.searchParams, headers: {}, body, auth, signal, origin: 'http://untrusted.invalid' }, route.pattern.exec(parsed.pathname)!.slice(1), ctx);
  };
  const create = async () => {
    const result = await call('POST', '/api/local/channels', { name: 'refactor', operationId: 'cli-1' });
    return (result as { json: { roomId: string } }).json.roomId;
  };
  const add = async (id: string, user = A, name = 'kevin-Codex', membership: Member['membership'] = 'join') => store.append(id, {
    type: 'm.room.member', sender: OWNER, content: { user, displayname: name, kind: 'agent', harness: 'codex', membership, 'com.khala.listening_mode': 'steer' },
  });
  return { store, ctx, routes, call, create, add, logs };
}
afterEach(() => vi.useRealTimers());
const data = (response: unknown) => (response as { json: Record<string, unknown> }).json;
const error = (status: number, code: string) => ({ status, json: { error: code } });

it('exports twelve routes and rejects unauthenticated and agent callers before parsing', async () => {
  const f = fixture(); expect(f.routes).toHaveLength(12);
  for (const route of f.routes.filter(r => !r.pattern.test(`/open/${'T'.repeat(43)}`))) {
    for (const [auth, expected] of [[{ kind: 'none' }, error(401, 'unauthorized')], [{ kind: 'agent', userId: A, roomId: 'missing' }, error(403, 'forbidden')]] as const) {
      expect(await route.handle({ auth, body: null } as LocalRequest, ['%ZZ', '%ZZ'], f.ctx)).toEqual(expected);
    }
  }
  for (const path of ['/api/local/open', '/api/local/shutdown']) expect(await f.call('POST', path, {}, COOKIE)).toEqual(error(403, 'forbidden'));
  expect(f.ctx.shutdown).not.toHaveBeenCalled();
});
it.each([false, true])('creates and replays with exactly one owner join (store joins=%s)', async storeJoins => {
  const f = fixture(storeJoins);
  const first = await f.call('POST', '/api/local/channels', { name: '  refactor ', operationId: 'cli-1' });
  const c = data(first); expect(first.status).toBe(201); expect(c.name).toBe('refactor');
  for (const key of ['selfLink', 'shareLink']) { expect(c[key]).toMatch(/^http:\/\/127\.0\.0\.1:47830\/join\/[A-Za-z0-9_-]{43}$/u); expect(parseChannelLink(c[key] as string)).toEqual({ origin: f.ctx.origin }); }
  expect(c.selfLink).not.toBe(c.shareLink); expect(c.openUrl).toMatch(/\/open\/[A-Za-z0-9_-]{43}$/u); expect(c.expiresAt).toBe(EXPIRES);
  const replay = await f.call('POST', '/api/local/channels', { name: 'changed', operationId: 'cli-1' });
  expect(replay.status).toBe(201); expect(data(replay)).toMatchObject({ roomId: c.roomId, name: 'refactor' }); expect(data(replay).selfLink).not.toBe(c.selfLink);
  expect(f.logs.get(c.roomId as string)?.map(e => e.type)).toEqual(['m.room.create', 'm.room.member']);
});
it.each([{}, null, [], { name: '' }, { name: '   ' }, { name: 'a'.repeat(65) }, { name: 'a\u0007b' }, { name: 3 }, { name: 'valid', operationId: 'bad id' }, { name: 'valid', operationId: null }, { name: 'valid', extra: true }])('rejects invalid create input %j', async body => {
  const f = fixture(); expect(await f.call('POST', '/api/local/channels', body)).toEqual(error(400, 'invalid_request')); expect(f.store.createChannel).not.toHaveBeenCalled();
});
it('counts channel name Unicode code points and allows a 64-character name', async () => {
  const f = fixture(); expect((await f.call('POST', '/api/local/channels', { name: '😀'.repeat(64) })).status).toBe(201);
});
it('lists summaries unchanged and reconciles by operation', async () => {
  const f = fixture(); const id = await f.create(); const path = `/api/local/channels/${encodeURIComponent(id)}`;
  expect(data(await f.call('GET', '/api/local/channels'))).toEqual({ revision: f.store.revision(), channels: f.store.listChannels() });
  expect(data(await f.call('GET', path))).toEqual(f.store.channelSummary(id));
  expect(data(await f.call('GET', '/api/local/channels/by-operation/cli-1'))).toEqual({ roomId: id });
  for (const url of ['/api/local/channels/missing', '/api/local/channels/%ZZ', '/api/local/channels/by-operation/missing', '/api/local/channels/by-operation/bad%20id']) expect(await f.call('GET', url)).toEqual(error(404, 'not_found'));
});
it('holds equal revisions, wakes on create, and passes abort to the store', async () => {
  const f = fixture(); const ac = new AbortController(); let done = false;
  const pending = f.call('GET', '/api/local/channels?since=0&wait=25', undefined, ADMIN, ac.signal).then(r => { done = true; return r; });
  await Promise.resolve(); expect(done).toBe(false); await f.create(); expect(data(await pending).revision).toBeGreaterThan(0);
  const next = f.call('GET', `/api/local/channels?since=${f.store.revision()}&wait=25`, undefined, ADMIN, ac.signal); ac.abort(); expect((await next).status).toBe(200);
  expect(f.store.waitForRevision).toHaveBeenLastCalledWith(f.store.revision(), 25000, ac.signal);
});
it('returns on polling timeout and skips waiting for stale or missing revisions', async () => {
  vi.useFakeTimers(); const f = fixture(); const pending = f.call('GET', '/api/local/channels?since=0&wait=1');
  await vi.advanceTimersByTimeAsync(1000); expect(data(await pending)).toEqual({ revision: 0, channels: [] });
  vi.mocked(f.store.waitForRevision).mockClear();
  for (const url of ['/api/local/channels?since=0&wait=0', '/api/local/channels?since=1&wait=25', '/api/local/channels?wait=25']) expect((await f.call('GET', url)).status).toBe(200);
  expect(f.store.waitForRevision).not.toHaveBeenCalled();
});
it.each(['wait=26', 'wait=-1', 'wait=1.5', 'wait=', 'since=-1', 'since=abc', 'since=', 'since=1234567890123456'])('rejects invalid polling query %s', async query => {
  expect(await fixture().call('GET', `/api/local/channels?${query}`)).toEqual(error(400, 'invalid_request'));
});
it('mints a fresh share link and deletes only matching pending joins', async () => {
  const f = fixture(); const id = await f.create(); const path = `/api/local/channels/${encodeURIComponent(id)}`;
  f.ctx.joins.set('a', { roomId: id } as HelperContext['joins'] extends Map<string, infer T> ? T : never);
  f.ctx.joins.set('b', { roomId: 'other' } as HelperContext['joins'] extends Map<string, infer T> ? T : never);
  expect(data(await f.call('POST', `${path}/links`))).toMatchObject({ expiresAt: EXPIRES, shareLink: expect.stringMatching(/\/join\/[A-Za-z0-9_-]{43}$/u) });
  expect(await f.call('DELETE', path)).toEqual({ status: 204 }); expect(f.ctx.joins.has('a')).toBe(false); expect(f.ctx.joins.has('b')).toBe(true);
  for (const method of ['DELETE', 'GET', 'POST'] as const) expect(await f.call(method, method === 'POST' ? `${path}/links` : path)).toEqual(error(404, 'not_found'));
});
it('sends owner mode commands with transaction dedup and rejects nonmembers', async () => {
  const f = fixture(); const id = await f.create(); await f.add(id); const path = `/api/local/channels/${encodeURIComponent(id)}/mode`;
  const body = { agent: A, mode: 'steer', txnId: 'txn_123' }; const response = await f.call('POST', path, body);
  expect(response.status).toBe(200); expect(await f.call('POST', path, body)).toEqual(response);
  expect(f.logs.get(id)!.at(-1)).toMatchObject({ type: 'com.khala.listening_mode.v1', sender: OWNER, content: { v: 1, agent: A, mode: 'steer' }, txnId: 'txn_123' });
  for (const input of [{ ...body, mode: 'loud' }, { ...body, txnId: '' }, { ...body, extra: 1 }, { ...body, agent: 'invalid' }]) expect(await f.call('POST', path, input)).toEqual(error(400, 'invalid_request'));
  for (const agent of [OWNER, B]) expect(await f.call('POST', path, { ...body, agent })).toEqual(error(404, 'not_found'));
});
it.each(['invite', 'join'] as const)('renames a %s member with hosted errors and preserves mode', async membership => {
  const f = fixture(); const id = await f.create(); await f.add(id, A, 'kevin-Codex', membership); const path = `/api/local/agents/${encodeURIComponent(A)}/name`;
  const renamed = await f.call('POST', path, { name: ' reviewer ' }); expect(data(renamed)).toEqual({ matrixUserId: A, name: 'reviewer' }); expect(decodeAgentRenameResult(data(renamed)).ok).toBe(true);
  expect(f.logs.get(id)!.at(-1)!.content).toEqual({ user: A, membership, displayname: 'reviewer', kind: 'agent', harness: 'codex', 'com.khala.listening_mode': 'steer' });
  const length = f.logs.get(id)!.length; expect((await f.call('POST', path, { name: 'reviewer' })).status).toBe(200); expect(f.logs.get(id)).toHaveLength(length);
  expect(await f.call('POST', path, { name: 'x' })).toEqual({ status: 400, json: { error: 'invalid_name', reason: 'too_short' } });
  expect(await f.call('POST', path, { name: 'System-bot' })).toEqual({ status: 400, json: { error: 'invalid_name', reason: 'reserved' } });
  expect(await f.call('POST', path, { name: 'KEVIN' })).toEqual(error(409, 'name_taken'));
  for (const body of [{ name: 3 }, { name: 'reviewer', extra: true }]) expect(await f.call('POST', path, body)).toEqual(error(400, 'invalid_request'));
  expect(await f.call('POST', '/api/local/agents/%ZZ/name', { name: 'reviewer' })).toEqual(error(400, 'invalid_request'));
  expect(await f.call('POST', `/api/local/agents/${encodeURIComponent(B)}/name`, { name: 'reviewer' })).toEqual(error(404, 'not_found'));
});
it('serializes competing renames and create replays', async () => {
  const f = fixture(); const ids = await Promise.all([f.create(), f.create()]); expect(ids[0]).toBe(ids[1]);
  const id = ids[0]!; expect(f.logs.get(id)!.filter(e => e.type === 'm.room.member')).toHaveLength(1); await f.add(id); await f.add(id, B, 'other');
  const responses = await Promise.all([A, B].map(user => f.call('POST', `/api/local/agents/${encodeURIComponent(user)}/name`, { name: 'reviewer' })));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
});
it('removes agents with preserved mode and a leave announcement without clearing tokens', async () => {
  const f = fixture(); const id = await f.create(); await f.add(id, A, 'reviewer'); const path = `/api/local/channels/${encodeURIComponent(id)}/members/${encodeURIComponent(A)}`;
  const results = await Promise.all([f.call('DELETE', path), f.call('DELETE', path)]); expect(results).toEqual([{ status: 204 }, error(404, 'not_found')]);
  expect(f.logs.get(id)!.at(-2)!.content).toEqual({ user: A, membership: 'leave', displayname: 'reviewer', kind: 'agent', harness: 'codex', 'com.khala.listening_mode': 'steer' });
  expect(f.logs.get(id)!.at(-1)!.content).toEqual({ v: 1, kind: 'member', summary: 'reviewer left', status: 'info', source: { system: 'khala-local' }, body: 'reviewer left' });
  expect(f.store.setMemberToken).not.toHaveBeenCalled();
  expect(await f.call('DELETE', `/api/local/channels/${encodeURIComponent(id)}/members/${encodeURIComponent(OWNER)}`)).toEqual(error(400, 'invalid_request'));
  expect(await f.call('POST', `/api/local/agents/${encodeURIComponent(A)}/name`, { name: 'reviewer' })).toEqual(error(404, 'not_found'));
});
it('mints admin-only open links and redeems once into the owner cookie', async () => {
  const f = fixture(); const id = await f.create(); const response = await f.call('POST', '/api/local/open', { roomId: id });
  const url = data(response).openUrl as string; expect(url.startsWith(f.ctx.origin)).toBe(true);
  const redeemed = await f.call('GET', url, undefined, { kind: 'none' });
  expect(redeemed).toEqual({ status: 302, location: `/channels/${encodeURIComponent(id)}`, headers: { 'set-cookie': `khala_local_owner=${'S'.repeat(43)}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  expect(await f.call('GET', url)).toEqual(error(404, 'link_unavailable')); expect(f.ctx.createOwnerSession).toHaveBeenCalledTimes(1);
  expect(await f.call('POST', '/api/local/open', { roomId: 'missing' })).toEqual(error(404, 'not_found'));
  for (const body of [{ roomId: 3 }, { extra: 1 }, null]) expect(await f.call('POST', '/api/local/open', body)).toEqual(error(400, 'invalid_request'));
});
it('redirects unscoped and deleted-channel open links to conversations and stops via admin', async () => {
  const f = fixture(); const id = await f.create();
  for (const body of [{}, { roomId: id }]) {
    const url = data(await f.call('POST', '/api/local/open', body)).openUrl as string;
    if ('roomId' in body) await f.store.deleteChannel(id);
    expect(await f.call('GET', url)).toMatchObject({ status: 302, location: '/conversations' });
  }
  expect(await f.call('POST', '/api/local/shutdown')).toEqual({ status: 204 }); expect(f.ctx.shutdown).toHaveBeenCalledTimes(1);
});
it('recovers the serial queue after a dependency failure without leaking its error', async () => {
  const f = fixture(); vi.mocked(f.store.createChannel).mockRejectedValueOnce(new Error('private-token'));
  expect(await f.call('POST', '/api/local/channels', { name: 'valid' })).toEqual(error(503, 'unavailable'));
  expect((await f.call('POST', '/api/local/channels', { name: 'valid' })).status).toBe(201);
});
it('removes only the removed agent pending joins and refuses commands after leave', async () => {
  const f = fixture(); const id = await f.create(); await f.add(id);
  const pending = (userId: string) => ({ roomId: id, credentials: { userId } }) as NonNullable<ReturnType<typeof f.ctx.joins.get>>;
  f.ctx.joins.set('removed', pending(A)); f.ctx.joins.set('other', pending(B));
  const base = `/api/local/channels/${encodeURIComponent(id)}`;
  expect((await f.call('DELETE', `${base}/members/${encodeURIComponent(A)}`)).status).toBe(204);
  expect([...f.ctx.joins.keys()]).toEqual(['other']);
  expect(await f.call('POST', `${base}/mode`, { agent: A, mode: 'async', txnId: 'txn_456' })).toEqual(error(404, 'not_found'));
  expect(await f.call('DELETE', `${base}/members/%ZZ`)).toEqual(error(400, 'invalid_request'));
});

it('waits for an injected shared queue before renaming an agent', async () => {
  const queue = serial();
  const f = fixture(false, queue);
  const id = await f.create(); await f.add(id);
  let release!: () => void;
  const held = queue(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const before = f.logs.get(id)!.length;
  let completed = false;
  const rename = f.call('POST', `/api/local/agents/${encodeURIComponent(A)}/name`, { name: 'reviewer' })
    .then(response => { completed = true; return response; });
  // Let an unqueued handler reach append; a correctly queued handler stays blocked.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(completed).toBe(false);
  expect(f.logs.get(id)).toHaveLength(before);
  release(); await held;
  expect(await rename).toEqual({ status: 200, json: { matrixUserId: A, name: 'reviewer' } });
  expect(f.logs.get(id)).toHaveLength(before + 1);
});
