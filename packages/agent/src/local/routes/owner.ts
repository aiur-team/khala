import type { AgentRenameResult } from '@khala/contracts/m1/agent-names';
import type { ChannelNameResult } from '@khala/contracts/m1/channel-names';
import { CHANNEL_EVENT_TYPE, encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import { DEFAULT_LISTENING_MODE, LISTENING_MODE_COMMAND_TYPE, LISTENING_MODE_MEMBER_KEY, decodeListeningModeCommand } from '@khala/contracts/m1/listening-mode';
import { LOCAL_LONG_POLL_MAX_S, LOCAL_OWNER_USER_ID } from '@khala/contracts/m1/local';
import { checkName } from '@khala/contracts/m1/names';
import { decodeWith, object } from '@khala/contracts/messaging/decode';
import type { LocalRequest, LocalResponse, LocalRoute, LocalStore } from '../types';

const ID = /^[A-Za-z0-9._-]{1,64}$/u;
const USER = /^@[^\s:]+:\S+$/u;
const fail = (status: number, error: string): LocalResponse => ({ status, json: { error } });
type Member = NonNullable<ReturnType<LocalStore['member']>>;
type Handler = LocalRoute['handle'];

export type SerialQueue = <T>(work: () => Promise<T>) => Promise<T>;

export function serial(): SerialQueue {
  let tail = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
function owner(req: LocalRequest, adminOnly: boolean): LocalResponse | null {
  if (req.auth.kind === 'none') return fail(401, 'unauthorized');
  if (req.auth.kind !== 'owner' || adminOnly && req.auth.via !== 'admin') return fail(403, 'forbidden');
  return null;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function decodeParam(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}
function channelParam(raw: string | undefined, store: LocalStore): string | null {
  const id = decodeParam(raw);
  return id !== null && store.hasChannel(id) ? id : null;
}
function memberContent(member: Member, membership: Member['membership'], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { user: member.userId, membership, displayname: member.displayName, kind: member.kind,
    ...(member.harness ? { harness: member.harness } : {}),
    ...(member.kind === 'agent' ? { [LISTENING_MODE_MEMBER_KEY]: member.listeningMode ?? DEFAULT_LISTENING_MODE } : {}), ...overrides };
}
async function announce(store: LocalStore, roomId: string, summary: string): Promise<void> {
  const encoded = encodeChannelEvent({ kind: 'member', summary, status: 'info', source: { system: 'khala-local' } });
  if (encoded.ok) await store.append(roomId, { type: CHANNEL_EVENT_TYPE, sender: LOCAL_OWNER_USER_ID, content: encoded.value });
}

export function ownerRoutes(options: { queue?: SerialQueue } = {}): LocalRoute[] {
  const queue = options.queue ?? serial();
  function route(method: LocalRequest['method'], pattern: RegExp, handler: Handler, options: { adminOnly?: boolean; public?: boolean; serial?: boolean } = {}): LocalRoute {
    return { method, pattern, async handle(req, params, ctx) {
      try {
        if (!options.public) {
          const denied = owner(req, options.adminOnly ?? false);
          if (denied) return denied;
        }
        return await (options.serial ? queue(() => handler(req, params, ctx)) : handler(req, params, ctx));
      } catch { return fail(503, 'unavailable'); }
    } };
  }
  return [
    route('GET', /^\/api\/local\/channels$/u, async (req, _params, { store }) => {
      const since = req.query.get('since');
      const wait = req.query.get('wait') ?? '0';
      if (since !== null && !/^\d{1,15}$/u.test(since) || !/^\d{1,2}$/u.test(wait) || Number(wait) > LOCAL_LONG_POLL_MAX_S) return fail(400, 'invalid_request');
      if (since !== null && Number(since) === store.revision() && Number(wait) > 0) await store.waitForRevision(Number(since), Number(wait) * 1000, req.signal);
      return { status: 200, json: { revision: store.revision(), channels: store.listChannels() } };
    }),
    route('GET', /^\/api\/local\/channels\/by-operation\/([^/]+)$/u, async (_req, params, { store }) => {
      const id = decodeParam(params[0]);
      if (id === null || !ID.test(id)) return fail(404, 'not_found');
      const roomId = store.findByOperation(id);
      return roomId === undefined ? fail(404, 'not_found') : { status: 200, json: { roomId } };
    }),
    route('GET', /^\/api\/local\/channels\/([^/]+)$/u, async (_req, params, { store }) => {
      const roomId = channelParam(params[0], store);
      const summary = roomId === null ? undefined : store.channelSummary(roomId);
      return summary === undefined ? fail(404, 'not_found') : { status: 200, json: summary };
    }),
    route('POST', /^\/api\/local\/channels$/u, async (req, _params, ctx) => {
      const body = req.body;
      if (!plainObject(body) || !Object.hasOwn(body, 'name') || Object.keys(body).some(key => key !== 'name' && key !== 'operationId') || typeof body.name !== 'string') return fail(400, 'invalid_request');
      const name = body.name.trim();
      if ([...name].length < 1 || [...name].length > 64 || /[\u0000-\u001f\u007f]/u.test(name)) return fail(400, 'invalid_request');
      if (Object.hasOwn(body, 'operationId') && (typeof body.operationId !== 'string' || !ID.test(body.operationId))) return fail(400, 'invalid_request');
      const { store } = ctx;
      const { roomId } = await store.createChannel(name, body.operationId as string | undefined);
      if (store.member(roomId, LOCAL_OWNER_USER_ID)?.membership !== 'join') await store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
        content: { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: store.owner().username, kind: 'human' } });
      const self = await store.mintLink(roomId, 'join');
      const share = await store.mintLink(roomId, 'join');
      const open = ctx.mintOpenToken(roomId);
      return { status: 201, json: { roomId, name: store.channelName(roomId), selfLink: `${ctx.origin}/join/${self.token}`, shareLink: `${ctx.origin}/join/${share.token}`, openUrl: `${ctx.origin}/open/${open.token}`, expiresAt: self.expiresAt } };
    }, { serial: true }),
    route('DELETE', /^\/api\/local\/channels\/([^/]+)$/u, async (_req, params, ctx) => {
      const roomId = channelParam(params[0], ctx.store);
      if (roomId === null) return fail(404, 'not_found');
      await ctx.store.deleteChannel(roomId);
      for (const [id, join] of ctx.joins) if (join.roomId === roomId) ctx.joins.delete(id);
      return { status: 204 };
    }, { serial: true }),
    route('POST', /^\/api\/local\/channels\/([^/]+)\/links$/u, async (_req, params, ctx) => {
      const roomId = channelParam(params[0], ctx.store);
      if (roomId === null) return fail(404, 'not_found');
      const link = await ctx.store.mintLink(roomId, 'join');
      return { status: 200, json: { shareLink: `${ctx.origin}/join/${link.token}`, expiresAt: link.expiresAt } };
    }, { serial: true }),
    route('POST', /^\/api\/local\/channels\/([^/]+)\/mode$/u, async (req, params, { store }) => {
      const roomId = channelParam(params[0], store);
      if (roomId === null) return fail(404, 'not_found');
      const body = decodeWith(() => {
        const reader = object(req.body, '', ['agent', 'mode', 'txnId']);
        return { agent: reader.field('agent'), mode: reader.field('mode'), txnId: reader.field('txnId') };
      });
      if (!body.ok || typeof body.value.txnId !== 'string' || !ID.test(body.value.txnId)) return fail(400, 'invalid_request');
      const command = decodeListeningModeCommand({ v: 1, agent: body.value.agent, mode: body.value.mode });
      if (!command.ok) return fail(400, 'invalid_request');
      const member = store.member(roomId, command.value.agent);
      if (!member || member.membership === 'leave' || member.kind !== 'agent') return fail(404, 'not_found');
      const event = await store.append(roomId, { type: LISTENING_MODE_COMMAND_TYPE, sender: LOCAL_OWNER_USER_ID, content: command.value, txnId: body.value.txnId });
      return { status: 200, json: { eventId: event.eventId } };
    }, { serial: true }),
    route('POST', /^\/api\/local\/agents\/([^/]+)\/name$/u, async (req, params, { store }) => {
      const userId = decodeParam(params[0]);
      if (userId === null || !USER.test(userId)) return fail(400, 'invalid_request');
      const body = decodeWith(() => object(req.body, '', ['name']).field('name'));
      if (!body.ok || typeof body.value !== 'string') return fail(400, 'invalid_request');
      const checked = checkName(body.value, 'agent');
      if (!checked.ok) return { status: 400, json: { error: 'invalid_name', reason: checked.error } };
      const roomId = store.channelOfMember(userId);
      if (roomId === undefined) return fail(404, 'not_found');
      const member = store.member(roomId, userId);
      if (!member || member.membership === 'leave' || member.kind !== 'agent') return fail(404, 'not_found');
      if (store.members(roomId).some(other => other.userId !== userId && other.displayName.toLowerCase() === checked.name.toLowerCase())) return fail(409, 'name_taken');
      if (member.displayName !== checked.name) await store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: memberContent(member, member.membership, { displayname: checked.name }) });
      return { status: 200, json: { matrixUserId: userId, name: checked.name } satisfies AgentRenameResult };
    }, { serial: true }),
    // The owner's own name in one channel. Only the owner's session reaches it; agents get 403 above,
    // and there is no subject field, so no one can rename another member here.
    route('POST', /^\/api\/local\/channels\/([^/]+)\/name$/u, async (req, params, { store }) => {
      const roomId = channelParam(params[0], store);
      if (roomId === null) return fail(404, 'not_found');
      const body = decodeWith(() => object(req.body, '', ['name']).field('name'));
      if (!body.ok || typeof body.value !== 'string') return fail(400, 'invalid_request');
      const checked = checkName(body.value, 'username');
      if (!checked.ok) return { status: 400, json: { error: 'invalid_name', reason: checked.error } };
      const self = store.member(roomId, LOCAL_OWNER_USER_ID);
      if (!self || self.membership !== 'join') return fail(404, 'not_found');
      if (store.members(roomId).some(other => other.userId !== LOCAL_OWNER_USER_ID && other.displayName.toLowerCase() === checked.name.toLowerCase())) return fail(409, 'name_taken');
      // The profile username is the default, so choosing it again clears the override.
      await store.setOwnerChannelName(roomId, checked.name === store.owner().username ? null : checked.name);
      return { status: 200, json: { name: checked.name } satisfies ChannelNameResult };
    }, { serial: true }),
    route('DELETE', /^\/api\/local\/channels\/([^/]+)\/members\/([^/]+)$/u, async (_req, params, ctx) => {
      const roomId = channelParam(params[0], ctx.store);
      if (roomId === null) return fail(404, 'not_found');
      const userId = decodeParam(params[1]);
      if (userId === null || !USER.test(userId) || userId === LOCAL_OWNER_USER_ID) return fail(400, 'invalid_request');
      const member = ctx.store.member(roomId, userId);
      if (!member || member.membership === 'leave') return fail(404, 'not_found');
      await ctx.store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: memberContent(member, 'leave') });
      await announce(ctx.store, roomId, `${member.displayName} left`);
      for (const [id, join] of ctx.joins) if (join.credentials.userId === userId) ctx.joins.delete(id);
      return { status: 204 };
    }, { serial: true }),
    route('POST', /^\/api\/local\/open$/u, async (req, _params, ctx) => {
      const body = req.body === undefined ? {} : req.body;
      if (!plainObject(body) || Object.keys(body).some(key => key !== 'roomId') || Object.hasOwn(body, 'roomId') && typeof body.roomId !== 'string') return fail(400, 'invalid_request');
      const roomId = body.roomId as string | undefined;
      if (roomId !== undefined && !ctx.store.hasChannel(roomId)) return fail(404, 'not_found');
      const link = ctx.mintOpenToken(roomId);
      return { status: 200, json: { openUrl: `${ctx.origin}/open/${link.token}`, expiresAt: link.expiresAt } };
    }, { adminOnly: true }),
    route('GET', /^\/open\/([A-Za-z0-9_-]{43})$/u, async (_req, params, ctx) => {
      const opened = ctx.consumeOpenToken(params[0]!);
      if (opened === null) return fail(404, 'link_unavailable');
      const sid = ctx.createOwnerSession();
      const location = opened.roomId && ctx.store.hasChannel(opened.roomId) ? `/channels/${encodeURIComponent(opened.roomId)}` : '/conversations';
      return { status: 302, location, headers: { 'set-cookie': `khala_local_owner=${sid}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } };
    }, { public: true }),
    route('POST', /^\/api\/local\/shutdown$/u, async (_req, _params, ctx) => {
      ctx.shutdown();
      return { status: 204 };
    }, { adminOnly: true }),
  ];
}
