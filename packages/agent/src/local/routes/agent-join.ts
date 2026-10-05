import { createHash, timingSafeEqual } from 'node:crypto';
import { agentConfirmPagePath, validAgentSessionId, validAgentRejoinSecret, type AgentCredentials, type AgentJoinCreated } from '@khala/contracts/m1/agent-join';
import { LOCAL_LINK_TTL_MS, LOCAL_OWNER_USER_ID, LOCAL_TOKEN_BYTES, newLocalAgentUserId } from '@khala/contracts/m1/local';
import { isHarnessId } from '@khala/contracts/m1/harness';
import { defaultLocalAgentName, freeLocalAgentName } from '../identity';
import { checkName } from '@khala/contracts/m1/names';
import { parseChannelLink } from '../../join';
import type { HelperContext, LocalRequest, LocalResponse, LocalRoute, PendingJoin } from '../types';

const sha256hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fail = (status: number, error: string): LocalResponse => ({ status, json: { error } });
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => { const run = tail.then(fn, fn); tail = run.catch(() => undefined); return run; };
}
function prune(ctx: HelperContext): void {
  const now = ctx.now();
  for (const [id, entry] of ctx.joins) if (now >= entry.expiresAt + LOCAL_LINK_TTL_MS) ctx.joins.delete(id);
}
function authenticate(req: LocalRequest, ctx: HelperContext): PendingJoin | null {
  const entries = [...req.query];
  if (entries.length !== 1 || entries[0]![0] !== 'joinId' || !/^[A-Za-z0-9_-]{22}$/u.test(entries[0]![1])) return null;
  const header = req.headers.authorization;
  const bearer = /^Bearer ([^\s]+)$/u.exec((Array.isArray(header) ? header[0] : header) ?? '');
  const entry = ctx.joins.get(entries[0]![1]);
  return bearer && entry && safeEqual(sha256hex(bearer[1]!), entry.pollSecretSha256) ? entry : null;
}

export function agentJoinRoutes(): LocalRoute[] {
  const queue = serial();
  async function create(req: LocalRequest, _params: string[], ctx: HelperContext): Promise<LocalResponse> {
    try {
      prune(ctx);
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return fail(400, 'invalid_link');
      const body = req.body as Record<string, unknown>;
      if (!Object.hasOwn(body, 'link') || Object.keys(body).some(key => !['link', 'harness', 'label', 'sessionId', 'rejoinSecret'].includes(key))) return fail(400, 'invalid_link');
      if (typeof body.link !== 'string' || !parseChannelLink(body.link)) return fail(400, 'invalid_link');
      if (Object.hasOwn(body, 'sessionId') && !validAgentSessionId(body.sessionId)) return fail(400, 'invalid_link');
      if (Object.hasOwn(body, 'rejoinSecret') && !validAgentRejoinSecret(body.rejoinSecret)) return fail(400, 'invalid_link');
      const harness = body.harness;
      if (!isHarnessId(harness)) return fail(400, 'invalid_harness');
      const url = new URL(body.link);
      if (url.origin !== ctx.origin && url.origin !== ctx.origin.replace('://127.0.0.1:', '://localhost:')) return fail(404, 'link_unavailable');
      const token = url.pathname.slice('/join/'.length);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return fail(404, 'link_unavailable');
      const username = ctx.store.owner().username;
      if (!checkName(defaultLocalAgentName(username, harness, 2), 'agent').ok) return fail(503, 'unavailable');
      return await queue(async () => {
        const link = await ctx.store.consumeLink(token);
        if (!link || !ctx.store.hasChannel(link.roomId)) return fail(404, 'link_unavailable');
        const roomId = link.roomId;
        const sessionKey = body.sessionId === undefined || body.rejoinSecret === undefined ? undefined : sha256hex(JSON.stringify([harness, body.sessionId, body.rejoinSecret]));
        const previous = sessionKey ? ctx.store.memberForSession(roomId, sessionKey) : undefined;
        // Names are unique per channel only: a taken default gets the lowest free `-N` here.
        const checked = checkName(freeLocalAgentName(username, harness, ctx.store.members(roomId).map(member => member.displayName)), 'agent');
        if (!checked.ok) return fail(503, 'unavailable');
        let userId = previous?.userId ?? newLocalAgentUserId(ctx.random(4));
        for (let attempt = 0; attempt < 5 && !previous && ctx.store.channelOfMember(userId) !== undefined; attempt++) userId = newLocalAgentUserId(ctx.random(4));
        if (!previous && ctx.store.channelOfMember(userId) !== undefined) return fail(503, 'unavailable');
        const deviceId = 'KH_LOCAL_' + userId.slice('@agent-'.length, -':local'.length);
        const accessToken = b64(ctx.random(LOCAL_TOKEN_BYTES));
        await ctx.store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
          content: { user: userId, membership: 'invite', displayname: previous?.displayName ?? checked.name, kind: 'agent', harness, invitedBy: LOCAL_OWNER_USER_ID,
            ...(previous ? { 'com.khala.listening_mode': previous.listeningMode ?? 'sync' } : {}) } });
        await ctx.store.setMemberToken(roomId, userId, sha256hex(accessToken), sessionKey);
        const joinId = b64(ctx.random(16)), pollSecret = b64(ctx.random(LOCAL_TOKEN_BYTES));
        const expiresAt = ctx.now() + LOCAL_LINK_TTL_MS;
        const credentials: AgentCredentials = { homeserver: ctx.origin, userId, accessToken, deviceId, roomId, transport: 'local' };
        ctx.joins.set(joinId, { joinId, pollSecretSha256: sha256hex(pollSecret), roomId, credentials, state: 'confirmed', expiresAt });
        const result: AgentJoinCreated = { joinId, pollSecret, confirmUrl: url.origin + agentConfirmPagePath(joinId),
          expiresAt: new Date(expiresAt).toISOString(), autoConfirmed: true };
        return { status: 201, json: result };
      });
    } catch { return fail(503, 'unavailable'); }
  }
  async function poll(req: LocalRequest, _params: string[], ctx: HelperContext): Promise<LocalResponse> {
    prune(ctx);
    const entry = authenticate(req, ctx);
    if (!entry) return fail(404, 'not_found');
    if (entry.state === 'confirmed' && ctx.now() >= entry.expiresAt) {
      ctx.joins.delete(entry.joinId);
      return { status: 200, json: { state: 'expired' } };
    }
    if (entry.state !== 'confirmed') return { status: 200, json: { state: 'claimed' } };
    ctx.joins.set(entry.joinId, { ...entry, state: 'claimed', credentials: { ...entry.credentials, accessToken: '' } });
    return { status: 200, json: { state: 'confirmed', credentials: entry.credentials } };
  }
  async function ready(req: LocalRequest, _params: string[], ctx: HelperContext): Promise<LocalResponse> {
    prune(ctx);
    const entry = authenticate(req, ctx);
    if (!entry) return fail(404, 'not_found');
    if (entry.state === 'confirmed') return fail(409, 'not_confirmed');
    entry.state = 'ready';
    return { status: 204 };
  }
  return [
    { method: 'POST', pattern: /^\/api\/agent\/join$/u, handle: create },
    { method: 'GET', pattern: /^\/api\/agent\/join\/poll$/u, handle: poll },
    { method: 'POST', pattern: /^\/api\/agent\/join\/ready$/u, handle: ready },
  ];
}
