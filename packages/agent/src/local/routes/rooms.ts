import { decodeChannelEvent, encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import { DEFAULT_LISTENING_MODE, LISTENING_MODE_MEMBER_KEY, decodeListeningMode } from '@khala/contracts/m1/listening-mode';
import { LOCAL_LONG_POLL_MAX_S, LOCAL_OWNER_USER_ID, type LocalEvent } from '@khala/contracts/m1/local';
import { decodeWith, object, utf8Length } from '@khala/contracts/messaging/decode';
import type { HelperContext, LocalRequest, LocalResponse, LocalRoute, LocalStore } from '../types';

const fail = (status: number, error: string): LocalResponse => ({ status, json: { error } });
type Member = NonNullable<ReturnType<LocalStore['member']>>;
type Caller = { userId: string; kind: 'owner' | 'agent'; roomId: string; member: Member };
type Need = 'any' | 'present' | 'joined';

function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function resolve(req: LocalRequest, params: string[], ctx: HelperContext, need: Need): Caller | LocalResponse {
  if (req.auth.kind === 'none') return fail(401, 'unauthorized');
  const userId = req.auth.kind === 'owner' ? LOCAL_OWNER_USER_ID : req.auth.userId;
  let roomId: string;
  try { roomId = decodeURIComponent(params[0]!); } catch { return fail(404, 'not_found'); }
  if (!ctx.store.hasChannel(roomId)) return fail(404, 'not_found');
  if (req.auth.kind === 'agent' && req.auth.roomId !== roomId) return fail(403, 'not_member');
  const member = ctx.store.member(roomId, userId);
  if (!member || (need === 'present' && member.membership === 'leave')
    || (need === 'joined' && member.membership !== 'join')) return fail(403, 'not_member');
  return { userId, kind: req.auth.kind, roomId, member };
}
const announcementTxn = (event: LocalEvent): string => `local.join.${event.eventId.slice(1)}`;
function memberEvents(store: LocalStore, roomId: string, userId: string) {
  let after = 0;
  let current: LocalEvent | undefined;
  let joined: LocalEvent | undefined;
  let announced = false;
  for (;;) {
    const page = store.eventsAfter(roomId, after, 200);
    for (const event of page) {
      if (event.type === 'm.room.member' && event.content['user'] === userId) {
        if (event.content['membership'] !== 'join') {
          joined = undefined;
          announced = false;
        } else if (current?.content['membership'] !== 'join') {
          joined = event;
          announced = false;
        }
        current = event;
      } else if (joined && event.type === 'com.khala.event.v1' && event.sender === LOCAL_OWNER_USER_ID
        && event.txnId === announcementTxn(joined)) {
        announced = true;
      }
    }
    if (page.length < 200) return { current, joined, announced };
    after = page.at(-1)!.seq;
  }
}
function memberContent(member: Member, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { user: member.userId, membership: 'join', displayname: member.displayName, kind: member.kind,
    ...(member.harness ? { harness: member.harness } : {}),
    ...(member.kind === 'agent' ? { [LISTENING_MODE_MEMBER_KEY]: member.listeningMode ?? DEFAULT_LISTENING_MODE } : {}),
    ...extra };
}

export function roomRoutes(): LocalRoute[] {
  const enqueue = serial();
  // Catch asynchronous store failures too, so the HTTP layer always receives a response.
  const route = (method: LocalRequest['method'], pattern: RegExp, need: Need,
    handle: (req: LocalRequest, params: string[], ctx: HelperContext, caller: Caller) => Promise<LocalResponse>): LocalRoute => ({
    method, pattern, async handle(req, params, ctx) {
      try {
        const caller = resolve(req, params, ctx, need);
        return 'status' in caller ? caller : await handle(req, params, ctx, caller);
      } catch { return fail(503, 'unavailable'); }
    },
  });
  return [
    route('GET', /^\/api\/local\/rooms\/([^/]+)\/me$/u, 'any', async (_req, _params, ctx, caller) => ({
      status: 200, json: { userId: caller.userId, roomId: caller.roomId, roomName: ctx.store.channelName(caller.roomId),
        membership: caller.member.membership, displayName: caller.member.displayName,
        ...(caller.kind === 'agent' ? { invitedBy: LOCAL_OWNER_USER_ID } : {}) },
    })),
    route('POST', /^\/api\/local\/rooms\/([^/]+)\/join$/u, 'present', async (req, params, ctx) => {
      if (req.body !== undefined && (!isPlainObject(req.body) || Object.keys(req.body).length > 0)) return fail(400, 'invalid_request');
      return enqueue(async () => {
        const caller = resolve(req, params, ctx, 'present');
        if ('status' in caller) return caller;
        let event: LocalEvent | undefined;
        let joined: LocalEvent | undefined;
        let announced = false;
        if (caller.member.membership === 'join') {
          ({ current: event, joined, announced } = memberEvents(ctx.store, caller.roomId, caller.userId));
        } else {
          event = await ctx.store.append(caller.roomId, { type: 'm.room.member', sender: caller.userId, content: memberContent(caller.member) });
          joined = event;
        }
        // A persisted join may survive a failed announcement append or helper restart.
        // Tie the announcement to that transition, rather than later mode echoes.
        if (caller.kind === 'agent' && joined && !announced) {
          const encoded = encodeChannelEvent({ kind: 'member', summary: `${joined.content['displayname']} joined`, status: 'info', source: { system: 'khala-local' } });
          if (encoded.ok) await ctx.store.append(caller.roomId, { type: 'com.khala.event.v1', sender: LOCAL_OWNER_USER_ID,
            content: { ...encoded.value }, txnId: announcementTxn(joined) });
        }
        return event ? { status: 200, json: { seq: event.seq, ts: event.ts } } : fail(503, 'unavailable');
      });
    }),
    route('GET', /^\/api\/local\/rooms\/([^/]+)\/events$/u, 'joined', async (req, params, ctx, caller) => {
      const rawAfter = req.query.get('after') ?? '0';
      const rawWait = req.query.get('wait') ?? '0';
      if (!/^\d{1,15}$/u.test(rawAfter) || !/^\d{1,2}$/u.test(rawWait) || Number(rawWait) > LOCAL_LONG_POLL_MAX_S) return fail(400, 'invalid_request');
      const after = Number(rawAfter);
      const wait = Number(rawWait);
      if (req.signal.aborted) return { status: 200, json: { events: [], next: after } };
      let events = ctx.store.eventsAfter(caller.roomId, after, 200);
      if (events.length === 0 && wait > 0) {
        await ctx.store.waitForEvent(caller.roomId, after, wait * 1000, req.signal);
        if (req.signal.aborted) return { status: 200, json: { events: [], next: after } };
        const current = resolve(req, params, ctx, 'joined');
        if ('status' in current) return current;
        events = ctx.store.eventsAfter(caller.roomId, after, 200);
      }
      // The shared helper may outlive older CLIs with strict event decoders.
      // Only clients advertising support receive the extended wire shape.
      const delivered = req.query.get('prev') === '1' ? events : events.map(event => {
        const legacy = { ...event };
        delete legacy.previousContent;
        return legacy;
      });
      return { status: 200, json: { events: delivered, next: events.at(-1)?.seq ?? after } };
    }),
    route('GET', /^\/api\/local\/rooms\/([^/]+)\/messages$/u, 'joined', async (req, _params, ctx, caller) => {
      const before = req.query.get('before');
      const limit = req.query.get('limit') ?? '50';
      if ((before !== null && !/^\$[A-Za-z0-9_-]{1,128}$/u.test(before)) || !/^\d{1,3}$/u.test(limit)
        || Number(limit) < 1 || Number(limit) > 100) return fail(400, 'invalid_request');
      return { status: 200, json: ctx.store.history(caller.roomId, before ?? undefined, Number(limit)) };
    }),
    route('POST', /^\/api\/local\/rooms\/([^/]+)\/send$/u, 'joined', async (req, params, ctx) => {
      const decoded = decodeWith(() => {
        const r = object(req.body, '', ['txnId', 'type', 'content']);
        return { txnId: r.field('txnId'), type: r.field('type'), content: r.field('content') };
      });
      if (!decoded.ok) return fail(400, 'invalid_request');
      const { txnId, type, content } = decoded.value;
      if (typeof txnId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(txnId)
        || (type !== 'm.room.message' && type !== 'com.khala.event.v1') || !isPlainObject(content)) return fail(400, 'invalid_request');
      if (utf8Length(JSON.stringify(content)) > 32_768) return fail(413, 'payload_too_large');
      let stored = content;
      if (type === 'm.room.message') {
        if ((content['msgtype'] !== 'm.text' && content['msgtype'] !== 'm.notice') || typeof content['body'] !== 'string'
          || content['body'].length < 1 || content['body'].length > 8000) return fail(400, 'invalid_request');
      } else {
        const event = decodeChannelEvent(content);
        if (!event.ok) return fail(400, 'invalid_request');
        stored = { ...event.value };
      }
      return enqueue(async () => {
        const caller = resolve(req, params, ctx, 'joined');
        if ('status' in caller) return caller;
        const event = await ctx.store.append(caller.roomId, { type, sender: caller.userId, content: stored, txnId });
        return { status: 200, json: { eventId: event.eventId } };
      });
    }),
    route('GET', /^\/api\/local\/rooms\/([^/]+)\/members$/u, 'joined', async (_req, _params, ctx, caller) => ({
      status: 200, json: { members: ctx.store.members(caller.roomId) },
    })),
    route('PUT', /^\/api\/local\/rooms\/([^/]+)\/members\/([^/]+)$/u, 'joined', async (req, params, ctx, caller) => {
      let target: string;
      try { target = decodeURIComponent(params[1]!); } catch { return fail(400, 'invalid_request'); }
      if (caller.kind !== 'agent' || target !== caller.userId) return fail(409, 'conflict');
      const body = decodeWith(() => object(req.body, '', ['listeningMode']).field('listeningMode'));
      const mode = decodeListeningMode(body.ok ? body.value : undefined);
      if (!body.ok || !mode.ok) return fail(400, 'invalid_request');
      return enqueue(async () => {
        const current = resolve(req, params, ctx, 'joined');
        if ('status' in current) return current;
        await ctx.store.append(current.roomId, { type: 'm.room.member', sender: current.userId,
          content: memberContent(current.member, { [LISTENING_MODE_MEMBER_KEY]: mode.value }) });
        return { status: 204 };
      });
    }),
  ];
}
