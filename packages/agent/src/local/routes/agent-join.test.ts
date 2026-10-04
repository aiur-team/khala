import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { AgentCredentials, AgentJoinCreated } from '@khala/contracts/m1/agent-join';
import { LOCAL_LINK_TTL_MS, LOCAL_OWNER_USER_ID, type LocalEvent, type LocalMember, type LocalMemberContent } from '@khala/contracts/m1/local';
import { pollJoin, reportReady, requestJoin } from '../../join';
import type { HelperContext, LocalRequest, LocalResponse, LocalStore } from '../types';
import { agentJoinRoutes } from './agent-join';

const origin = 'http://127.0.0.1:47830';
const roomId = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const joinPath = '/api/agent/join';

type CallInput = { method?: LocalRequest['method']; url: string; body?: unknown; headers?: IncomingHttpHeaders; auth?: LocalRequest['auth'] };
function fixture(opts: { username?: string; names?: string[]; left?: string[] } = {}) {
  const clock = { t: Date.parse('2026-10-02T09:00:00.000Z') };
  const links = new Map<string, { expiresAt: number; consumed: boolean }>();
  const events: LocalEvent[] = [];
  const tokens: { roomId: string; userId: string; tokenSha256: string | null }[] = [];
  const sessions = new Map<string, string>();
  const membership = new Map<string, LocalMemberContent>();
  const seed = (user: string, displayname: string, state: LocalMemberContent['membership']) => {
    membership.set(user, { user, displayname, membership: state, kind: user === LOCAL_OWNER_USER_ID ? 'human' : 'agent' });
  };
  seed(LOCAL_OWNER_USER_ID, opts.username ?? 'kevin', 'join');
  (opts.names ?? []).forEach((name, i) => seed(`@agent-${i.toString(16).padStart(8, '0')}:local`, name, 'invite'));
  (opts.left ?? []).forEach((name, i) => seed(`@agent-${(i + 100).toString(16).padStart(8, '0')}:local`, name, 'leave'));
  const implemented = {
    owner: () => ({ v: 1, username: opts.username ?? 'kevin', color: 'blue', initials: null, updatedAt: '2026-10-02T00:00:00.000Z' }),
    members: (): LocalMember[] => [...membership.values()].filter(m => m.membership !== 'leave').map(m => ({
      userId: m.user, participantId: m.user, ownerId: 'local-owner',
      deviceId: m.user === LOCAL_OWNER_USER_ID ? 'KH_LOCAL_OWNER' : 'KH_LOCAL_' + m.user.slice(7, 15),
      displayName: m.displayname, membership: m.membership as 'invite' | 'join', kind: m.kind,
      ...(m.harness ? { harness: m.harness } : {}),
    })),
    memberForSession: (_roomId: string, key: string) => {
      const userId = sessions.get(key);
      const content = userId ? membership.get(userId) : undefined;
      return content ? { userId, displayName: content.displayname, listeningMode: content['com.khala.listening_mode'] } : undefined;
    },
    hasChannel: (id: string) => id === roomId,
    channelOfMember: (id: string) => membership.has(id) ? roomId : undefined,
    consumeLink: async (token: string) => {
      const link = links.get(token);
      if (!link || link.consumed || clock.t >= link.expiresAt) return null;
      link.consumed = true;
      return { roomId };
    },
    append: async (id: string, input: Parameters<LocalStore['append']>[1]): Promise<LocalEvent> => {
      // Expose concurrent naming races before the invite becomes visible.
      await new Promise(resolve => setTimeout(resolve, 0));
      const event: LocalEvent = { ...input, roomId: id, seq: events.length + 1, eventId: '$test', ts: clock.t };
      events.push(event);
      const content = input.content as LocalMemberContent;
      membership.set(content.user, content);
      return event;
    },
    setMemberToken: async (id: string, userId: string, tokenSha256: string | null, sessionKey?: string) => { if (sessionKey) sessions.set(sessionKey, userId); tokens.push({ roomId: id, userId, tokenSha256 }); },
  };
  const store = new Proxy(implemented, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    return () => { throw new Error('not used'); };
  } }) as unknown as LocalStore;
  let counter = 1;
  const ctx: HelperContext = { store, origin, now: () => clock.t, random: bytes => Uint8Array.from({ length: bytes }, () => counter++ % 256),
    version: 'test', joins: new Map(), mintOpenToken: () => { throw new Error('not used'); }, consumeOpenToken: () => null,
    createOwnerSession: () => { throw new Error('not used'); }, shutdown: () => { throw new Error('not used'); } };
  const routes = agentJoinRoutes();
  async function call(input: CallInput): Promise<LocalResponse> {
    const url = new URL(input.url, origin);
    const req: LocalRequest = { method: input.method ?? 'POST', path: url.pathname, query: url.searchParams,
      body: input.body, headers: input.headers ?? {}, auth: input.auth ?? { kind: 'none' }, origin, signal: new AbortController().signal };
    const route = routes.find(r => r.method === req.method && r.pattern.test(req.path));
    if (!route) throw new Error('route not found');
    return route.handle(req, route.pattern.exec(req.path)!.slice(1), ctx);
  }
  const fetchVia = (async (input, init) => {
    const result = await call({ url: String(input), method: (init?.method ?? 'GET') as LocalRequest['method'],
      headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(result.status === 204 ? null : JSON.stringify('json' in result ? result.json : undefined), { status: result.status });
  }) as typeof fetch;
  function link(expiresAt = clock.t + LOCAL_LINK_TTL_MS): string {
    const token = Buffer.alloc(32, links.size + 1).toString('base64url');
    links.set(token, { expiresAt, consumed: false });
    return origin + '/join/' + token;
  }
  async function create(body = { link: link(), harness: 'codex' }): Promise<AgentJoinCreated> {
    const result = await call({ url: joinPath, body });
    expect(result.status).toBe(201);
    return ('json' in result ? result.json : undefined) as AgentJoinCreated;
  }
  function sessionCall(session: AgentJoinCreated, endpoint: 'poll' | 'ready', extra: Partial<CallInput> = {}) {
    return call({ url: `${joinPath}/${endpoint}?joinId=${session.joinId}`, method: endpoint === 'poll' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${session.pollSecret}` }, ...extra });
  }
  return { clock, links, events, tokens, membership, store, ctx, routes, call, fetchVia, link, create, sessionCall };
}

function json(result: LocalResponse): unknown { return 'json' in result ? result.json : undefined; }

describe('agentJoinRoutes', () => {
  it('exports exactly the three hosted agent endpoints', () => {
    const { routes } = fixture();
    expect(routes.map(r => [r.method, r.pattern.source])).toEqual([
      ['POST', '^\\/api\\/agent\\/join$'], ['GET', '^\\/api\\/agent\\/join\\/poll$'], ['POST', '^\\/api\\/agent\\/join\\/ready$'],
    ]);
  });

  it('completes the unchanged real client handshake and appends an invite', async () => {
    const f = fixture();
    const link = f.link();
    const session = await requestJoin({ link, harness: 'codex', label: 'Codex' }, { fetch: f.fetchVia });
    expect(session).toMatchObject({ origin, confirmUrl: origin + '/agent/confirm?joinId=' + session.joinId,
      expiresAt: new Date(f.clock.t + LOCAL_LINK_TTL_MS).toISOString() });
    expect(session.joinId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(session.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const credentials = await pollJoin(session, { fetch: f.fetchVia, intervalMs: 1, sleep: async () => {} });
    expect(credentials).toMatchObject({ homeserver: origin, roomId });
    expect(credentials.userId).toMatch(/^@agent-[0-9a-f]{8}:local$/u);
    expect(credentials.deviceId).toBe('KH_LOCAL_' + credentials.userId.slice(7, 15));
    expect(credentials.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
      content: { user: credentials.userId, membership: 'invite', displayname: 'kevin-Codex', kind: 'agent', harness: 'codex', invitedBy: LOCAL_OWNER_USER_ID } });
    expect(f.events[0]!.txnId).toBeUndefined();
    expect(f.tokens).toEqual([{ roomId, userId: credentials.userId, tokenSha256: hash(credentials.accessToken) }]);
    await reportReady(session, { fetch: f.fetchVia });
    expect(f.ctx.joins.get(session.joinId)!.state).toBe('ready');
    await expect(requestJoin({ link, harness: 'codex', label: 'Codex' }, { fetch: f.fetchVia })).rejects.toMatchObject({ code: 'link_unavailable' });
  });

  it.each(['claude', 'codex', 'cursor'] as const)('reuses a %s session member, preserves rename and mode, and separates other sessions', async harness => {
    const f = fixture();
    const first = await requestJoin({ link: f.link(), harness, label: 'Codex', sessionId: 'thread-1', rejoinSecret: 'S'.repeat(43) }, { fetch: f.fetchVia });
    const before = await pollJoin(first, { fetch: f.fetchVia });
    const member = f.membership.get(before.userId)!;
    member.displayname = 'ReviewHelper';
    member['com.khala.listening_mode'] = 'async';
    const restarted = await requestJoin({ link: f.link(), harness, label: 'Codex', sessionId: 'thread-1', rejoinSecret: 'S'.repeat(43) }, { fetch: f.fetchVia });
    const after = await pollJoin(restarted, { fetch: f.fetchVia });
    expect(after.userId).toBe(before.userId);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(f.store.members(roomId)).toHaveLength(2);
    expect(f.events.at(-1)?.content).toEqual({ user: before.userId, membership: 'invite', displayname: 'ReviewHelper', kind: 'agent', harness, invitedBy: LOCAL_OWNER_USER_ID, 'com.khala.listening_mode': 'async' });
    await requestJoin({ link: f.link(), harness, label: 'Codex', sessionId: 'thread-2', rejoinSecret: 'S'.repeat(43) }, { fetch: f.fetchVia });
    expect(f.store.members(roomId)).toHaveLength(3);
  });

  it('creates a separate member and leaves the original token alone when the rejoin secret is wrong or missing', async () => {
    const f = fixture();
    const original = await pollJoin(await requestJoin({ link: f.link(), harness: 'cursor', label: 'Cursor', sessionId: 'cursor-default', rejoinSecret: 'S'.repeat(43) }, { fetch: f.fetchVia }), { fetch: f.fetchVia });
    for (const rejoinSecret of ['T'.repeat(43), 'S'.repeat(42) + 'T', undefined]) {
      const attacker = await pollJoin(await requestJoin({ link: f.link(), harness: 'cursor', label: 'Evil', sessionId: 'cursor-default', ...(rejoinSecret ? { rejoinSecret } : {}) }, { fetch: f.fetchVia }), { fetch: f.fetchVia });
      expect(attacker.userId).not.toBe(original.userId);
    }
    expect(f.tokens.filter(token => token.userId === original.userId)).toEqual([{ roomId, userId: original.userId, tokenSha256: hash(original.accessToken) }]);
    expect(f.events.map(e => e.content.displayname)).toEqual(['kevin-Cursor', 'kevin-Cursor-2', 'kevin-Cursor-3', 'kevin-Cursor-4']);
    expect(f.events.every(e => !Object.hasOwn(e.content, 'com.khala.rejoin'))).toBe(true);
    const rejoined = await pollJoin(await requestJoin({ link: f.link(), harness: 'cursor', label: 'Cursor', sessionId: 'cursor-default', rejoinSecret: 'S'.repeat(43) }, { fetch: f.fetchVia }), { fetch: f.fetchVia });
    expect(rejoined.userId).toBe(original.userId);
  });

  it('never reuses a member for a session id presented without any rejoin secret', async () => {
    const f = fixture();
    const users: string[] = [];
    for (let i = 0; i < 2; i++) {
      users.push((await pollJoin(await requestJoin({ link: f.link(), harness: 'cursor', label: 'Cursor', sessionId: 'cursor-default' }, { fetch: f.fetchVia }), { fetch: f.fetchVia })).userId);
    }
    expect(users[0]).not.toBe(users[1]);
    expect(f.events.map(e => e.content.displayname)).toEqual(['kevin-Cursor', 'kevin-Cursor-2']);
  });

  it('assigns the suffix to a different session while same-session joins keep the original', async () => {
    const f = fixture();
    for (const sessionId of ['thread-1', 'thread-1', 'thread-2']) {
      await requestJoin({ link: f.link(), harness: 'codex', label: 'Codex', sessionId, rejoinSecret: 'S'.repeat(43) }, { fetch: f.fetchVia });
    }
    expect(f.events.map(e => e.content.displayname)).toEqual(['kevin-Codex', 'kevin-Codex', 'kevin-Codex-2']);
  });

  it('returns raw local flags and credentials exactly once, erasing plaintext secrets', async () => {
    const f = fixture();
    const session = await f.create();
    expect(session.autoConfirmed).toBe(true);
    const stored = f.ctx.joins.get(session.joinId)!;
    expect(stored.pollSecretSha256).toBe(hash(session.pollSecret));
    expect(JSON.stringify([...f.ctx.joins.values()])).not.toContain(session.pollSecret);
    const [first, second] = await Promise.all([f.sessionCall(session, 'poll'), f.sessionCall(session, 'poll')]);
    const body = json(first) as { state: string; credentials: AgentCredentials };
    expect(body.state).toBe('confirmed');
    expect(body.credentials.transport).toBe('local');
    expect(body.credentials.accessToken).toHaveLength(43);
    expect(json(second)).toEqual({ state: 'claimed' });
    expect(f.ctx.joins.get(session.joinId)!.credentials.accessToken).toBe('');
    expect(JSON.stringify([...f.ctx.joins.values()])).not.toContain(body.credentials.accessToken);
    await expect(pollJoin({ ...session, origin }, { fetch: f.fetchVia })).rejects.toMatchObject({ code: 'join_expired', message: 'claimed' });
  });

  it('makes ready require a claim and remain idempotent', async () => {
    const f = fixture(), session = await f.create();
    expect(await f.sessionCall(session, 'ready')).toEqual({ status: 409, json: { error: 'not_confirmed' } });
    await f.sessionCall(session, 'poll');
    expect(await f.sessionCall(session, 'ready')).toEqual({ status: 204 });
    expect(await f.sessionCall(session, 'ready')).toEqual({ status: 204 });
    expect(json(await f.sessionCall(session, 'poll'))).toEqual({ state: 'claimed' });
  });

  it.each([null, [], {}, { link: 12 }, { link: 'not a url', harness: 'claude' }, { link: 'LINK', harness: 'claude', extra: 1 }])('rejects malformed input without consuming a link: %j', async input => {
    const f = fixture(), link = f.link();
    const body = input && !Array.isArray(input) && input.link === 'LINK' ? { ...input, link } : input;
    expect(await f.call({ url: joinPath, body })).toEqual({ status: 400, json: { error: 'invalid_link' } });
    await f.create({ link, harness: 'claude' });
  });

  it.each(['gemini', undefined, 42])('rejects bad harness %j before consuming', async harness => {
    const f = fixture(), link = f.link();
    expect(await f.call({ url: joinPath, body: { link, harness } })).toEqual({ status: 400, json: { error: 'invalid_harness' } });
    await f.create({ link, harness: 'claude' });
  });

  it.each(['System', '', 42, undefined])('ignores label %j', async label => {
    const f = fixture();
    const body = { link: f.link(), harness: 'claude', ...(label === undefined ? {} : { label }) };
    expect((await f.call({ url: joinPath, body })).status).toBe(201);
    expect(f.events[0]!.content.displayname).toBe('kevin-Claude');
  });

  it.each([
    { names: ['kevin-Claude'], expected: 'kevin-Claude-2' },
    { names: ['KEVIN-claude'], expected: 'kevin-Claude-2' },
    { names: ['kevin-Claude', 'kevin-Claude-2'], expected: 'kevin-Claude-3' },
    { names: [], left: ['kevin-Claude'], expected: 'kevin-Claude' },
  ])('allocates the smallest available name: %j', async opts => {
    const f = fixture(opts);
    await f.create({ link: f.link(), harness: 'claude' });
    expect(f.events[0]!.content.displayname).toBe(opts.expected);
  });

  it('serializes concurrent naming and invite appends', async () => {
    const f = fixture();
    await Promise.all([f.create({ link: f.link(), harness: 'claude' }), f.create({ link: f.link(), harness: 'claude' })]);
    expect(f.events.map(e => e.content.displayname)).toEqual(['kevin-Claude', 'kevin-Claude-2']);
  });

  it('consumes a shared link only once under concurrent requests', async () => {
    const f = fixture(), link = f.link();
    const results = await Promise.all([1, 2].map(() => f.call({ url: joinPath, body: { link, harness: 'codex' } })));
    expect(results.map(r => r.status)).toEqual([201, 404]);
    expect(json(results[1]!)).toEqual({ error: 'link_unavailable' });
    expect(f.events).toHaveLength(1);
  });

  it('rejects unknown, expired, foreign and wrong-length tokens without appending', async () => {
    const f = fixture(), link = f.link(), expired = f.link(f.clock.t);
    for (const unavailable of [origin + '/join/' + 'Z'.repeat(43), expired, link.replace(':47830', ':9999'), link.replace('127.0.0.1', '[::1]'), origin + '/join/' + 'A'.repeat(42)]) {
      expect(await f.call({ url: joinPath, body: { link: unavailable, harness: 'codex' } })).toEqual({ status: 404, json: { error: 'link_unavailable' } });
    }
    expect(f.events).toEqual([]);
    await f.create({ link, harness: 'codex' });
  });

  it('uses the localhost link origin for confirmation and canonical origin for credentials', async () => {
    const f = fixture(), session = await f.create({ link: f.link().replace('127.0.0.1', 'localhost'), harness: 'codex' });
    expect(session.confirmUrl).toBe('http://localhost:47830/agent/confirm?joinId=' + session.joinId);
    expect(json(await f.sessionCall(session, 'poll'))).toMatchObject({ credentials: { homeserver: origin } });
  });

  it.each(['poll', 'ready'] as const)('makes all %s authentication failures indistinguishable', async endpoint => {
    const f = fixture(), session = await f.create();
    const url = `${joinPath}/${endpoint}?joinId=${session.joinId}`;
    for (const extra of [
      { headers: {} }, { headers: { authorization: 'Basic abc' } }, { headers: { authorization: 'Bearer wrong' } },
      { headers: { authorization: `Bearer ${session.pollSecret} extra` } },
      { url: `${joinPath}/${endpoint}?joinId=${'Z'.repeat(22)}` }, { url: `${joinPath}/${endpoint}` },
      { url: url + '&x=1' }, { url: url + '&joinId=' + session.joinId }, { url: `${joinPath}/${endpoint}?joinId=bad` },
      { headers: {}, auth: { kind: 'owner', via: 'cookie' } as const },
      { headers: {}, auth: { kind: 'agent', userId: '@agent-12345678:local', roomId } as const },
    ]) expect(await f.sessionCall(session, endpoint, extra)).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(f.ctx.joins.get(session.joinId)!.state).toBe('confirmed');
  });

  it('accepts the first authorization array entry and ignores req.auth', async () => {
    const f = fixture(), session = await f.create();
    expect(json(await f.sessionCall(session, 'poll', { headers: { authorization: [`Bearer ${session.pollSecret}`, 'Bearer wrong'] } as unknown as IncomingHttpHeaders,
      auth: { kind: 'agent', userId: '@agent-12345678:local', roomId } }))).toMatchObject({ state: 'confirmed' });
  });

  it('expires unclaimed credentials at the deadline and removes the pending join', async () => {
    const f = fixture(), session = await f.create();
    f.clock.t += LOCAL_LINK_TTL_MS;
    expect(await f.sessionCall(session, 'poll')).toEqual({ status: 200, json: { state: 'expired' } });
    expect(f.ctx.joins.has(session.joinId)).toBe(false);
    expect(await f.sessionCall(session, 'poll')).toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('reports expired and restarted joins through the real client', async () => {
    const f = fixture(), session = await f.create();
    f.clock.t += LOCAL_LINK_TTL_MS;
    await expect(pollJoin({ ...session, origin }, { fetch: f.fetchVia })).rejects.toMatchObject({ code: 'join_expired', message: 'expired' });
    f.ctx.joins.clear();
    await expect(pollJoin({ ...session, origin }, { fetch: f.fetchVia })).rejects.toMatchObject({ code: 'join_expired', message: 'not_found' });
  });

  it.each(['poll', 'ready', 'create'] as const)('prunes retained joins on %s after the extra TTL', async endpoint => {
    const f = fixture(), session = await f.create();
    await f.sessionCall(session, 'poll');
    f.clock.t += LOCAL_LINK_TTL_MS * 2 - 1;
    expect(json(await f.sessionCall(session, 'poll'))).toEqual({ state: 'claimed' });
    f.clock.t++;
    if (endpoint === 'create') await f.create();
    else expect(await f.sessionCall(session, endpoint)).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(f.ctx.joins.has(session.joinId)).toBe(false);
  });

  it('rejects a defensive invalid owner name before consuming a link', async () => {
    const f = fixture({ username: 'bad name' }), link = f.link();
    expect(await f.call({ url: joinPath, body: { link, harness: 'codex' } })).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect([...f.links.values()][0]!.consumed).toBe(false);
  });

  it('retries occupied user IDs and derives the device ID from the final ID', async () => {
    const f = fixture({ names: ['existing'] });
    const realRandom = f.ctx.random;
    let first = true;
    f.ctx.random = bytes => { if (bytes === 4 && first) { first = false; return new Uint8Array(4); } return realRandom(bytes); };
    const session = await f.create();
    const body = json(await f.sessionCall(session, 'poll')) as { credentials: AgentCredentials };
    expect(body.credentials.userId).not.toBe('@agent-00000000:local');
    expect(body.credentials.deviceId).toBe('KH_LOCAL_' + body.credentials.userId.slice(7, 15));
  });

  it('bounds ID collision retries and recovers the serial queue after failure', async () => {
    const f = fixture({ names: ['existing'] }), realRandom = f.ctx.random;
    let attempts = 0;
    f.ctx.random = bytes => { attempts++; return new Uint8Array(bytes); };
    expect(await f.call({ url: joinPath, body: { link: f.link(), harness: 'codex' } })).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect(attempts).toBe(6);
    expect(f.events).toEqual([]);
    f.ctx.random = realRandom;
    await f.create();
  });

  it('turns a store exception into unavailable and allows subsequent queued creates', async () => {
    const f = fixture(), append = f.store.append;
    f.store.append = async () => { throw new Error('disk failure'); };
    expect(await f.call({ url: joinPath, body: { link: f.link(), harness: 'codex' } })).toEqual({ status: 503, json: { error: 'unavailable' } });
    f.store.append = append;
    await f.create();
  });
});
