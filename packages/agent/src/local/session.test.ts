import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKhalaAgentClient } from '../client-impl';
import { createKhalaTools } from '../mcp/tools';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { LOCAL_OWNER_USER_ID as owner, type LocalEvent, type LocalMember } from '@khala/contracts/m1/local';
import { createLocalSession, type LocalSessionOptions } from './session';
import type { ChannelSession, SessionMessage } from '../transport';
import { toInboxEntry } from '../sender';
import { resolveStateDir } from '../state';

const self = '@agent-a1b2c3d4:local';
const other = '@agent-11223344:local';
const room = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
const token = 'secret-local-access-token';
const creds: AgentCredentials = { homeserver: 'http://127.0.0.1:47830', accessToken: token, roomId: room, userId: self, deviceId: 'KH_LOCAL_a1b2c3d4', transport: 'local' };
const sessions: ChannelSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.stop())); vi.useRealTimers(); });
const tick = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const network = (code: string): Error => new TypeError('fetch failed', { cause: { code } });
function fakeHelper() {
  const events: LocalEvent[] = [];
  const calls: { method: string; url: string; auth: string | null; body: unknown; signal: AbortSignal }[] = [];
  const pending = new Set<{ wake: () => void; reject: (error: unknown) => void }>();
  const member = (userId: string, displayName: string): LocalMember => ({ userId, participantId: userId, ownerId: 'local-owner',
    deviceId: userId === owner ? 'KH_LOCAL_OWNER' : `KH_LOCAL_${userId.slice(7, 15)}`, displayName,
    kind: userId === owner ? 'human' : 'agent', membership: 'join' });
  const h = {
    events, calls, down: false, membership: 'invite' as 'invite' | 'join' | 'leave', meUser: self,
    invitedBy: owner as string | undefined, members: [member(owner, 'owner'), member(self, 'agent'), member(other, 'kevin-Codex')],
    eventsStatus: 200, duplicate: false, loseSendResponse: false, announceOnJoin: false, historyNext: undefined as string | undefined,
    intercept: undefined as ((call: typeof calls[number]) => Response | Promise<Response> | void) | undefined,
    append(type: LocalEvent['type'], sender: string, content: Record<string, unknown>, roomId = room): LocalEvent {
      const seq = events.length + 1;
      const event: LocalEvent = { seq, eventId: '$' + String(seq).padStart(22, 'e'), roomId, type, sender, ts: 1_700_000_000_000 + seq, content };
      events.push(event);
      for (const p of [...pending]) p.wake();
      return event;
    },
    kill() { h.down = true; for (const p of [...pending]) p.reject(network('ECONNRESET')); },
    fetch: undefined as unknown as typeof fetch,
    ensure: vi.fn(async () => { h.down = false; }),
    sleeps: [] as number[],
    onSleep: undefined as (() => void) | undefined,
    sleep: async (ms: number, signal?: AbortSignal) => { if (signal?.aborted) throw new Error('aborted'); h.sleeps.push(ms); h.onSleep?.(); },
  };
  h.append('m.room.create', owner, { name: 'refactor', createdBy: owner });
  h.append('m.room.member', owner, { user: owner, membership: 'join', displayname: 'owner', kind: 'human' });
  h.append('m.room.member', owner, { user: self, membership: 'invite', displayname: 'agent', kind: 'agent', harness: 'codex', invitedBy: owner });
  h.append('m.room.message', owner, { msgtype: 'm.text', body: 'before' });
  const transactions = new Map<string, LocalEvent>();
  h.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const signal = init!.signal!;
    const call = { method: init?.method ?? 'GET', url: url.href, auth: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined, signal };
    calls.push(call);
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const override = h.intercept?.(call);
    if (override !== undefined) return override;
    if (h.down) throw network('ECONNREFUSED');
    const tail = url.pathname.split('/').at(-1);
    if (tail === 'me') return json({ userId: h.meUser, roomId: room, roomName: 'refactor', membership: h.membership,
      displayName: 'agent', ...(h.invitedBy !== undefined ? { invitedBy: h.invitedBy } : {}) });
    if (tail === 'join') {
      h.membership = 'join';
      const event = h.append('m.room.member', self, { user: self, membership: 'join', displayname: 'agent', kind: 'agent', harness: 'codex' });
      if (h.announceOnJoin) h.append('com.khala.event.v1', owner, { body: 'agent joined' });
      return json({ seq: event.seq, ts: event.ts });
    }
    if (tail === 'members') return json({ members: h.members });
    if (call.method === 'PUT') {
      const body = call.body as { listeningMode: string };
      h.append('m.room.member', self, { user: self, membership: 'join', displayname: 'agent', kind: 'agent', harness: 'codex', 'com.khala.listening_mode': body.listeningMode });
      return new Response(null, { status: 204 });
    }
    if (tail === 'send') {
      const body = call.body as { txnId: string; type: LocalEvent['type']; content: Record<string, unknown> };
      let event = transactions.get(body.txnId);
      if (!event) { event = h.append(body.type, self, body.content); transactions.set(body.txnId, event); }
      if (h.loseSendResponse) { h.loseSendResponse = false; throw network('ECONNREFUSED'); }
      return json({ eventId: event.eventId });
    }
    if (tail === 'messages') {
      const before = url.searchParams.get('before');
      const beforeSeq = before ? events.find(e => e.eventId === before)?.seq ?? Infinity : Infinity;
      const page = events.filter(e => e.seq < beforeSeq && ['m.room.message', 'com.khala.event.v1'].includes(e.type)).slice(-Number(url.searchParams.get('limit')));
      return json({ events: page, ...(h.historyNext !== undefined ? { nextBefore: h.historyNext } : {}) });
    }
    if (tail === 'events') {
      if (h.eventsStatus !== 200) return json({ error: h.eventsStatus === 404 ? 'not_found' : h.eventsStatus === 401 ? 'unauthorized' : 'not_member' }, h.eventsStatus);
      const after = Number(url.searchParams.get('after'));
      const page = () => {
        const newer = events.filter(e => e.seq > after).slice(0, 200);
        const selected = h.duplicate && newer.length ? events.filter(e => e.seq >= after).slice(0, 200) : newer;
        return json({ events: selected, next: selected.at(-1)?.seq ?? after });
      };
      if (events.some(e => e.seq > after)) return page();
      return new Promise<Response>((resolve, reject) => {
        const cleanup = () => { pending.delete(p); signal.removeEventListener('abort', abort); };
        const p = { wake: () => { cleanup(); resolve(page()); }, reject: (error: unknown) => { cleanup(); reject(error); } };
        const abort = () => p.reject(new DOMException('aborted', 'AbortError'));
        pending.add(p); signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('unexpected_route');
  }) as typeof fetch;
  return h;
}
async function setup(options: LocalSessionOptions = {}) {
  const h = fakeHelper();
  const logs: string[] = [];
  const s = await createLocalSession(creds, { fetch: h.fetch, ensureHelper: h.ensure, sleep: h.sleep, log: line => logs.push(line), ...options });
  sessions.push(s);
  return { h, s, logs };
}
const append = (h: ReturnType<typeof fakeHelper>, sender: string = owner, body = 'live') => h.append('m.room.message', sender, { msgtype: 'm.text', body });

it('starts at join cutoff, filters own messages, keeps history and classifies local senders', async () => {
  const { h, s } = await setup();
  const received: SessionMessage[] = [];
  s.onMessage(m => received.push(m));
  await s.waitForInvite(room, 120_000);
  await s.join(room);
  expect(h.calls.find(c => c.url.includes('/events?'))?.url).toContain('after=5&wait=25');
  await s.send(room, 'mine');
  const ownerEvent = append(h);
  const agentEvent = append(h, other);
  await tick();
  expect(received.map(m => m.eventId)).toEqual([ownerEvent.eventId, agentEvent.eventId]);
  expect((await s.history(room, 30)).messages.map(m => m.body)).toEqual(['before', 'mine', 'live', 'live']);
  expect(toInboxEntry(received[0]!).senderKind).toBe('human');
  expect(toInboxEntry(received[1]!).senderKind).toBe('agent');
  for (const c of h.calls) { expect(c.auth).toBe(`Bearer ${token}`); expect(c.url).not.toContain(token); expect(c.url).not.toContain('/ignored'); }
});
it('delivers in order once, including overlapping pages, without lowering the cursor', async () => {
  const { h, s } = await setup();
  const ids: string[] = [];
  s.onMessage(m => ids.push(m.eventId));
  await s.join(room);
  const first = append(h);
  await tick();
  h.duplicate = true;
  const rest = [append(h, other), append(h), append(h)];
  await tick();
  expect(ids).toEqual([first, ...rest].map(e => e.eventId));
  const cursors = h.calls.filter(c => c.url.includes('/events?')).map(c => Number(new URL(c.url).searchParams.get('after')));
  expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
});
it('resumes after reset/refusal with persisted events and no rejoin or duplicates', async () => {
  const { h, s } = await setup();
  const ids: string[] = [];
  s.onMessage(m => ids.push(m.eventId));
  await s.join(room);
  const first = append(h); await tick();
  h.duplicate = true; h.kill(); const second = append(h);
  await tick();
  expect(ids).toEqual([first.eventId, second.eventId]);
  expect(h.ensure).toHaveBeenCalledTimes(1);
  expect(h.sleeps).toEqual([500, 1000]);
  expect(h.calls.filter(c => c.url.endsWith('/join'))).toHaveLength(1);
  expect(h.calls.filter(c => c.url.includes('after=6'))).toHaveLength(3);
  await s.join(room);
  expect(h.calls.filter(c => c.url.endsWith('/join'))).toHaveLength(1);
});
it('caps backoff and restarts at failures 1, 6 and 11, swallowing helper failures', async () => {
  const { h, s, logs } = await setup();
  const at: number[] = [];
  h.ensure.mockImplementation(async () => { at.push(h.sleeps.length + 1); throw new Error(token); });
  const sleeps: number[] = h.sleeps;
  // Trigger refusal on the initial poll rather than the request/response join.
  h.intercept = c => { if (c.url.includes('/events?')) throw network('ECONNREFUSED'); };
  h.onSleep = () => { if (sleeps.length === 12) void s.stop(); };
  await s.join(room); await tick();
  expect(sleeps.slice()).toEqual([500, 1000, 2000, 4000, ...Array<number>(8).fill(8000)]);
  expect(at).toEqual([1, 6, 11]);
  expect(logs).toContain('local_helper_unavailable');
  expect(logs.join()).not.toContain(token);
});
it('dispatches owner mode commands separately and caches names before delivery, isolating handlers', async () => {
  const { h, s, logs } = await setup();
  const modes = vi.fn(); const seen = vi.fn();
  s.onListeningModeCommand(() => { throw new Error(token); }); s.onListeningModeCommand(modes);
  s.onMessage(() => { throw new Error(token); });
  s.onMessage(m => { expect(s.displayName(other)).toBe('reviewer'); seen(m); });
  await s.join(room);
  expect(s.displayName(other)).toBe('kevin-Codex');
  expect(s.inviter(room)).toBe(owner);
  const content = { v: 1, agent: self, mode: 'steer' };
  const command = h.append('com.khala.listening_mode.v1', owner, content);
  h.append('com.khala.listening_mode.v1', self, content);
  h.append('m.room.member', self, { user: other, membership: 'join', displayname: 'reviewer', kind: 'agent', harness: 'codex' });
  h.append('m.room.name', owner, { name: 'refactor-2' });
  append(h, other); await tick();
  expect(modes).toHaveBeenCalledExactlyOnceWith({ eventId: command.eventId, roomId: room, sender: owner, ts: command.ts, content });
  expect(seen).toHaveBeenCalledTimes(2); expect(s.roomName(room)).toBe('refactor-2');
  expect(seen.mock.calls[0]![0]).toMatchObject({ type: 'm.room.member', previousContent: { membership: 'join', displayname: 'kevin-Codex' } });
  expect(logs).toEqual(['mode_handler_error', 'message_handler_error', 'message_handler_error']);
});
it('stop aborts pending fetch, is idempotent, disables handlers and rejects every asynchronous operation', async () => {
  const { h, s } = await setup(); const received = vi.fn(); s.onMessage(received);
  const ended = vi.fn(); s.onEnded!(ended);
  await s.join(room);
  const poll = h.calls.at(-1)!;
  await s.stop(); await s.stop();
  expect(poll.signal.aborted).toBe(true);
  const count = h.calls.length; append(h); await tick();
  expect(received).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(count);
  expect(ended).not.toHaveBeenCalled();
  for (const operation of [() => s.send(room, 'x'), () => s.sendChannelEvent(room, {}), () => s.history(room, 30),
    () => s.publishListeningMode(room, 'async'), () => s.waitForInvite(room, 10), () => s.join(room)]) {
    await expect(operation()).rejects.toThrow('session_stopped');
  }
});
it.each([401, 403, 404])('ends delivery on %s and rejects later calls with a safe terminal error', async status => {
  const { h, s, logs } = await setup(); h.eventsStatus = status;
  const ended = vi.fn(); s.onEnded!(ended);
  const unsubscribed = vi.fn(); s.onEnded!(unsubscribed)();
  await s.join(room); await tick();
  const count = h.calls.length;
  for (const op of [() => s.send(room, 'x'), () => s.history(room, 30), () => s.publishListeningMode(room, 'sync'), () => s.sendChannelEvent(room, {})]) {
    await expect(op()).rejects.toThrow(status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : 'not_member');
  }
  expect(h.calls).toHaveLength(count);
  expect(ended).toHaveBeenCalledExactlyOnceWith(status === 404 ? 'channel_deleted' : status === 403 ? 'removed' : 'unauthorized');
  expect(unsubscribed).not.toHaveBeenCalled();
  expect(logs).toEqual([status === 404 ? 'local_channel_gone' : 'local_session_revoked']);
});
it('retries refused sends once with the same transaction ID', async () => {
  const { h, s } = await setup();
  let first = true;
  h.intercept = c => {
    if (c.url.endsWith('/send') && first) { first = false; throw network('ECONNREFUSED'); }
  };
  const result = await s.send(room, 'hi');
  const bodies = h.calls.filter(c => c.url.endsWith('/send')).map(c => c.body);
  expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ txnId: expect.stringMatching(/^kls-[0-9a-f-]{36}$/u), type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } });
  expect(h.events.filter(e => e.eventId === result.eventId)).toHaveLength(1);
  expect(h.ensure).toHaveBeenCalledTimes(1);
  const txnId = 'khev-' + 'a'.repeat(32);
  const event = await s.sendChannelEvent(room, { v: 1 }, txnId);
  expect(await s.sendChannelEvent(room, { v: 1 }, txnId)).toEqual(event);
  await s.sendChannelEvent(room, {});
  expect(h.calls.at(-1)?.body).toMatchObject({ txnId: expect.stringMatching(/^kls-/u), type: 'com.khala.event.v1' });
});
it('publishes mode via an authenticated PUT and honors caller cancellation', async () => {
  const { h, s } = await setup();
  await s.publishListeningMode(room, 'async');
  expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', body: { listeningMode: 'async' } });
  expect(h.calls.at(-1)?.url).toContain('/members/%40agent-a1b2c3d4%3Alocal');
  const abort = new AbortController(); abort.abort();
  await expect(s.publishListeningMode(room, 'sync', abort.signal)).rejects.toThrow('request_aborted');
  expect(h.ensure).not.toHaveBeenCalled();
});
it('returns oldest-first history and optional pagination without filtering self or old messages', async () => {
  const { h, s } = await setup();
  await s.send(room, 'one'); const end = append(h);
  h.historyNext = h.events[3]!.eventId;
  const page = await s.history(room, 30, end.eventId);
  expect(page.messages.map(m => m.body)).toEqual(['before', 'one']);
  expect(page.nextBefore).toBe(h.historyNext);
  expect(h.calls.at(-1)?.url).toContain(`limit=30&before=${encodeURIComponent(end.eventId)}`);
  h.historyNext = undefined;
  expect(await s.history(room, 30)).not.toHaveProperty('nextBefore');
});
it('waits for invite with the exact timeout code and preserves inviter across me refresh', async () => {
  const { h, s } = await setup(); h.membership = 'leave';
  await expect(s.waitForInvite(room, 1000)).rejects.toThrow(/^invite_timeout$/u);
  expect(h.sleeps).toEqual([250, 250, 250, 250]);
  h.membership = 'invite'; h.invitedBy = undefined;
  await s.waitForInvite(room, 1000); await s.join(room);
  expect(s.inviter(room)).toBe(owner);
});
it('rejects wrong identity and malformed successful bodies, with no leaked response text', async () => {
  const h = fakeHelper(); h.meUser = other;
  await expect(createLocalSession(creds, { fetch: h.fetch })).rejects.toThrow(/^protocol$/u);
  h.meUser = self; h.intercept = () => new Response(token);
  await expect(createLocalSession(creds, { fetch: h.fetch })).rejects.toThrow(/^protocol$/u);
});
it('rejects other rooms and supplies the owner fallback', async () => {
  const h = fakeHelper(); h.invitedBy = undefined;
  const s = await createLocalSession(creds, { fetch: h.fetch }); sessions.push(s);
  expect(s.inviter(room)).toBe(owner); expect(s.inviter('unknown')).toBeUndefined(); expect(s.roomName('unknown')).toBeUndefined();
  for (const op of [() => s.send('unknown', 'x'), () => s.join('unknown'), () => s.history('unknown', 30),
    () => s.waitForInvite('unknown', 10), () => s.sendChannelEvent('unknown', {}), () => s.publishListeningMode('unknown', 'sync')]) {
    await expect(op()).rejects.toThrow('unknown_room');
  }
});
it.each(['unsafe_state_dir', 'storage_failed', 'helper_unavailable'])('normalizes helper failure %s without secrets', async code => {
  const h = fakeHelper(); h.down = true;
  await expect(createLocalSession(creds, { fetch: h.fetch, ensureHelper: async () => { throw Object.assign(new Error(token), { code }); } }))
    .rejects.toMatchObject({ code: 'internal_error', message: code });
});
it('retries an aggregate refused error once, but does not restart for reset or HTTP errors', async () => {
  const { h, s } = await setup();
  let attempts = 0;
  h.intercept = () => { attempts++; throw new TypeError(token, { cause: { errors: [{ code: 'ECONNREFUSED' }] } }); };
  await expect(s.send(room, 'hi')).rejects.toThrow(/^local_network_error$/u);
  expect(attempts).toBe(2); expect(h.ensure).toHaveBeenCalledTimes(1);
  h.intercept = () => { throw network('ECONNRESET'); };
  await expect(s.send(room, 'hi')).rejects.toThrow('local_network_error');
  h.intercept = () => new Response(token, { status: 500 });
  await expect(s.send(room, 'hi')).rejects.toThrow(/^http_500$/u);
  expect(h.ensure).toHaveBeenCalledTimes(1);
});
it('shares concurrent joins and stops delivery immediately when a handler stops the session', async () => {
  const { h, s } = await setup(); const second = vi.fn();
  s.onMessage(() => { void s.stop(); }); s.onMessage(second);
  await Promise.all([s.join(room), s.join(room)]);
  append(h); append(h); await tick();
  expect(h.calls.filter(c => c.url.endsWith('/join'))).toHaveLength(1);
  expect(second).not.toHaveBeenCalled();
});

it('reuses the transaction ID when a committed send loses its response', async () => {
  const { h, s } = await setup(); h.loseSendResponse = true;
  const result = await s.send(room, 'persisted');
  const posts = h.calls.filter(c => c.url.endsWith('/send'));
  expect(posts).toHaveLength(2); expect(posts[0]!.body).toEqual(posts[1]!.body);
  expect(h.events.filter(e => e.content['body'] === 'persisted')).toHaveLength(1);
  expect(result.eventId).toBe(h.events.at(-1)!.eventId);
});
it('never delivers events from another room or own channel/mode events, and unsubscribes', async () => {
  const { h, s } = await setup(); const seen = vi.fn(); const mode = vi.fn();
  const off = s.onMessage(seen); const offMode = s.onListeningModeCommand(mode);
  await s.join(room);
  h.append('m.room.message', owner, { msgtype: 'm.text', body: 'wrong' }, '!aaaaaaaaaaaaaaaaaaaaaa:local');
  await s.sendChannelEvent(room, { body: 'mine' });
  h.append('com.khala.listening_mode.v1', self, { v: 1, agent: self, mode: 'sync' });
  await tick(); expect(seen).not.toHaveBeenCalled(); expect(mode).not.toHaveBeenCalled();
  off(); offMode(); append(h); h.append('com.khala.listening_mode.v1', owner, {});
  await tick(); expect(seen).not.toHaveBeenCalled(); expect(mode).not.toHaveBeenCalled();
});
it('honors cancellation during an in-flight PUT', async () => {
  const { h, s } = await setup();
  h.intercept = c => c.method === 'PUT' ? new Promise<Response>((_, reject) => {
    c.signal.addEventListener('abort', () => reject(new Error(token)), { once: true });
  }) : undefined;
  const controller = new AbortController();
  const put = s.publishListeningMode(room, 'sync', controller.signal);
  controller.abort(); await expect(put).rejects.toThrow('request_aborted');
  expect(h.ensure).not.toHaveBeenCalled();
});

it('delivers the owner join announcement after the cutoff and uses pinned timeouts', async () => {
  const timeouts = vi.spyOn(AbortSignal, 'timeout');
  try {
    const { h, s } = await setup(); h.announceOnJoin = true;
    const seen = vi.fn(); s.onMessage(seen);
    await s.join(room); await tick();
    expect(seen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'com.khala.event.v1', body: 'agent joined' }));
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 10_000, 10_000, 35_000, 35_000]);
  } finally { timeouts.mockRestore(); }
});
it('rejects a completed body read after stop without returning its result', async () => {
  const { h, s } = await setup();
  let finish!: (value: unknown) => void;
  const body = new Promise<unknown>(resolve => { finish = resolve; });
  h.intercept = c => c.url.endsWith('/send') ? { status: 200, ok: true, json: () => body } as Response : undefined;
  const sending = s.send(room, 'pending'); await tick();
  await s.stop(); finish({ eventId: '$' + 'e'.repeat(22) });
  await expect(sending).rejects.toThrow('session_stopped');
});

it('does not echo the bearer even in an otherwise valid error body', async () => {
  const { h, s } = await setup();
  h.intercept = () => json({ error: token }, 400);
  await expect(s.send(room, 'hi')).rejects.toThrow(/^http_400$/u);
});

async function localClient(h: ReturnType<typeof fakeHelper>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'khala-1049-status-'));
  const client = createKhalaAgentClient({ harness: 'codex', sessionId: 'local', env: { XDG_STATE_HOME: root },
    startSession: credentials => createLocalSession(credentials, { fetch: h.fetch, ensureHelper: h.ensure, sleep: h.sleep }),
    joinApi: {
      requestJoin: async () => ({ origin: 'http://127.0.0.1:47830', joinId: 'j', pollSecret: 'p',
        confirmUrl: 'http://127.0.0.1:47830/agent/confirm', expiresAt: '2099-01-01T00:00:00Z', autoConfirmed: true }),
      pollJoin: async () => creds, reportReady: async () => {},
    },
  });
  const statusTool = createKhalaTools({ harness: 'codex', clientFor: () => client }).find(t => t.name === 'khala_status')!;
  return { client, dir: resolveStateDir('codex', 'local', { XDG_STATE_HOME: root }), status: () => statusTool.call({}, { id: 1, notification: false, meta: undefined }), cleanup: async () => {
    await client.close(); await rm(root, { recursive: true, force: true });
  } };
}
it.each([[401, 'unauthorized'], [403, 'removed'], [404, 'channel_deleted']] as const)(
  'reports disconnected/%s through khala_status when polling ends', async (code, detail) => {
    const h = fakeHelper(); const c = await localClient(h);
    try {
      expect(await c.client.join('http://127.0.0.1:47830/join/abcdefgh', 'Codex')).toMatchObject({ state: 'connected' });
      h.eventsStatus = code; append(h);
      await vi.waitFor(async () => expect(await c.status()).toMatchObject({ result: {
        structuredContent: { state: 'disconnected', detail },
      } }));
      await expect(c.client.send('after removal')).rejects.toMatchObject({ code: 'not_connected' });
      expect(await c.client.status()).not.toHaveProperty('agentUserId');
      h.eventsStatus = 200;
      expect(await c.client.join('http://127.0.0.1:47830/join/abcdefgh', 'Codex')).toMatchObject({ state: 'connected' });
      expect(await c.client.status()).not.toHaveProperty('detail');
    } finally { await c.cleanup(); }
  });
it('does not overwrite an early polling end with connected', async () => {
  const h = fakeHelper(); h.eventsStatus = 403; const c = await localClient(h);
  try {
    await expect(c.client.join('http://127.0.0.1:47830/join/abcdefgh', 'Codex')).rejects.toThrow('removed');
    expect(await c.client.status()).toMatchObject({ state: 'disconnected', detail: 'removed' });
  } finally { await c.cleanup(); }
});
it.each(['unsafe_state_dir', 'storage_failed'] as const)('exposes helper %s during startup and sending', async detail => {
  const h = fakeHelper(); const c = await localClient(h);
  h.ensure.mockRejectedValue(Object.assign(new Error(token), { code: detail }));
  try {
    h.down = true;
    await expect(c.client.join('http://127.0.0.1:47830/join/abcdefgh', 'Codex')).rejects.toThrow(detail);
    expect(await c.status()).toMatchObject({ result: { structuredContent: { state: 'disconnected', detail } } });
    h.down = false;
    // A new link starts a fresh attempt after the failed handshake.
    await c.client.join('http://127.0.0.1:47830/join/ijklmnop', 'Codex');
    h.intercept = call => { if (call.url.endsWith('/send')) throw network('ECONNREFUSED'); };
    await expect(c.client.send('retry')).rejects.toMatchObject({ code: 'send_failed' });
    expect(await c.status()).toMatchObject({ result: { structuredContent: { state: 'send_failed', detail } } });
    await expect(c.client.sendChannelEvent({ v: 1, kind: 'custom', summary: 'event', body: 'event' })).rejects.toMatchObject({ code: 'send_failed' });
    expect(await c.client.status()).toMatchObject({ state: 'send_failed', detail });
  } finally { await c.cleanup(); }
});

it.each([
  'http://192.0.2.1:443', 'http://khala.invalid:443', 'http://0.0.0.0:443',
  'https://khala.invalid:443', 'https://127.0.0.1:47830', 'ftp://localhost:47830',
  'http://localhost.evil.invalid:47830', 'http://127.0.0.2:47830',
  'http://[::]:47830', 'http://[::ffff:127.0.0.1]:47830',
  `http://user:${token}@localhost:47830`, 'http://user@127.0.0.1:47830',
  'http://localhost:47830/ignored', 'http://localhost:47830/..',
  'http://localhost:47830?secret=value', 'http://localhost:47830#fragment',
  'http://localhost:99999', `invalid-${token}`,
  'http://localhost', 'http://localhost:47830?', 'http://localhost:47830#',
  ' http://localhost:47830', 'http://localhost:47830/./',
  'http://127.1:47830', 'http://2130706433:47830',
])('rejects unsafe LocalSession homeserver %s before fetch or helper startup', async homeserver => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(network('ECONNREFUSED'));
  const ensureHelper = vi.fn(async () => {});
  const log = vi.fn();
  await expect(createLocalSession({ ...creds, homeserver }, { fetch, ensureHelper, log }))
    .rejects.toMatchObject({ name: 'KhalaClientError', code: 'internal_error', message: 'invalid_local_origin' });
  expect(fetch).not.toHaveBeenCalled();
  expect(ensureHelper).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});
it.each(['http://127.0.0.1:47830', 'http://localhost:47830', 'http://[::1]:47830', 'http://localhost:80/'])(
  'accepts HTTP loopback origin %s', async homeserver => {
    const h = fakeHelper();
    const s = await createLocalSession({ ...creds, homeserver }, { fetch: h.fetch, ensureHelper: h.ensure });
    sessions.push(s);
    expect(h.calls[0]?.url).toBe(new URL(homeserver).origin + `/api/local/rooms/${encodeURIComponent(room)}/me`);
    expect(h.calls[0]?.auth).toBe(`Bearer ${token}`);
  });

it('delivers a username cascade and self rename once without any agent speaking', async () => {
  const h = fakeHelper(); const c = await localClient(h);
  try {
    await c.client.join('http://127.0.0.1:47830/join/abcdefgh', 'Codex');
    h.duplicate = true;
    const ownerRename = h.append('m.room.member', owner, { user: owner, membership: 'join', displayname: 'kev', kind: 'human' });
    const selfRename = h.append('m.room.member', owner, { user: self, membership: 'join', displayname: 'kev-Codex', kind: 'agent', harness: 'codex' });
    const otherRename = h.append('m.room.member', owner, { user: other, membership: 'join', displayname: 'kev-Codex-2', kind: 'agent', harness: 'codex' });
    h.append('m.room.member', other, { user: other, membership: 'join', displayname: 'kev-Codex-2', kind: 'agent', harness: 'codex', 'com.khala.listening_mode': 'async' });
    const explicitRename = h.append('m.room.member', owner, { user: other, membership: 'join', displayname: 'reviewer', kind: 'agent', harness: 'codex' });
    await tick();
    expect(await c.client.status()).toMatchObject({ displayName: 'kev-Codex', unread: 4 });
    const inbox = (await readFile(path.join(c.dir, 'inbox.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(inbox.map(e => [e.eventId, e.kind, e.body])).toEqual([
      [ownerRename.eventId, 'event', 'owner is now kev'],
      [selfRename.eventId, 'event', 'agent is now kev-Codex'],
      [otherRename.eventId, 'event', 'kevin-Codex is now kev-Codex-2'],
      [explicitRename.eventId, 'event', 'kev-Codex-2 is now reviewer'],
    ]);
  } finally { await c.cleanup(); }
});

it('requests previous membership and keeps a rename when the post-join roster already contains its new name', async () => {
  const { h, s } = await setup(); const seen = vi.fn(); s.onMessage(seen);
  h.intercept = call => {
    if (!call.url.endsWith('/members')) return;
    const content = { user: other, membership: 'join' as const, displayname: 'reviewer', kind: 'agent' as const, harness: 'codex' as const };
    const rename = h.append('m.room.member', owner, content);
    rename.previousContent = { ...content, displayname: 'kevin-Codex' };
    h.members.find(m => m.userId === other)!.displayName = 'reviewer';
  };
  await s.join(room); await tick();
  expect(h.calls.find(call => call.url.includes('/events?'))?.url).toContain('&prev=1');
  expect(seen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'm.room.member',
    previousContent: expect.objectContaining({ displayname: 'kevin-Codex' }) }));
});
