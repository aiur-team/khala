import { agentConfirmPagePath, HARNESSES, validAgentSessionId, type Harness, type AgentJoinCreated } from '@khala/contracts/m1/agent-join';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { type ControlStore, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { consumeJoinBudget, createJoinStore, effectiveState, isJoinId, JOIN_TTL_MS, hashPollSecret, openCredentials, pollSecretMatches, resolveJoinLink, type JoinRecord } from './store';
export { AGENT_JOIN_PATH } from '@khala/contracts/m1/agent-join';
export const AGENT_JOIN_POLL_PATH = '/api/agent/join/poll';
export const AGENT_JOIN_READY_PATH = '/api/agent/join/ready';
export type AgentJoinAgentDeps = Readonly<{
  joins: ReturnType<typeof createJoinStore>; store: ControlStore; clock: () => number;
  random: (bytes: number) => Uint8Array; origin: string; secret: string;
  roomName(ownerId: OwnerId, roomId: RoomId): Promise<string | null>;
}>;
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const error = (code: string, status: number) => json({ error: code }, status);
const empty = () => new Response(null, { status: 204, headers });

export function createAgentJoinAgentHandlers(deps: AgentJoinAgentDeps) {
  function guarded(method: string, handler: (request: Request) => Promise<Response>) {
    return async (request: Request): Promise<Response> => {
      try {
        if (request.method !== method) return error('method_not_allowed', 405);
        return await handler(request);
      } catch { return error('unavailable', 503); }
    };
  }
  async function authenticate(request: Request): Promise<{ record: JoinRecord; revision: string } | null> {
    const params = new URL(request.url).searchParams;
    const entries = [...params];
    if (entries.length !== 1 || entries[0]![0] !== 'joinId') return null;
    const joinId = params.get('joinId');
    const bearer = /^Bearer ([^\s]+)$/u.exec(request.headers.get('authorization') ?? '');
    if (!isJoinId(joinId) || !bearer) return null;
    const read = await deps.joins.read(joinId);
    if (read.kind !== 'found' || !pollSecretMatches(bearer[1]!, read.record.pollSecretHash)) return null;
    return read;
  }
  const create = guarded('POST', async request => {
    if (await consumeJoinBudget(deps, request.headers.get('x-nf-client-connection-ip') ?? 'unknown') === 'limited') return error('rate_limited', 429);
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return error('invalid_link', 400);
    let body: unknown;
    try { body = await request.json(); } catch { return error('invalid_link', 400); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return error('invalid_link', 400);
    const r = body as Record<string, unknown>;
    if (Object.keys(r).some(key => !['link', 'harness', 'label', 'sessionId'].includes(key)) || !['link', 'harness', 'label'].every(key => Object.hasOwn(r, key)) || typeof r.link !== 'string') return error('invalid_link', 400);
    if (Object.hasOwn(r, 'sessionId') && !validAgentSessionId(r.sessionId)) return error('invalid_link', 400);
    if (!(HARNESSES as readonly unknown[]).includes(r.harness)) return error('invalid_harness', 400);
    const label = validateAgentName(r.label);
    if (!label.ok || [...label.name].length > 40) return error('invalid_label', 400);
    const link = await resolveJoinLink({ ...deps, link: r.link });
    if (link.kind !== 'ok') return error(link.kind, link.kind === 'invalid_link' ? 400 : link.kind === 'link_unavailable' ? 404 : 503);
    const channelName = await deps.roomName(link.creatorOwnerId, link.roomId) ?? 'Untitled channel';
    const joinId = Buffer.from(deps.random(16)).toString('base64url');
    const pollSecret = Buffer.from(deps.random(32)).toString('base64url');
    const now = deps.clock();
    const record: JoinRecord = { joinId, pollSecretHash: hashPollSecret(pollSecret), roomId: link.roomId, channelName,
      ...(r.sessionId === undefined ? {} : { sessionId: r.sessionId as string }), label: label.name, harness: r.harness as Harness, state: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + JOIN_TTL_MS).toISOString() };
    if (await deps.joins.create(record) !== 'created') return error('unavailable', 503);
    const result: AgentJoinCreated = { joinId, pollSecret, confirmUrl: deps.origin + agentConfirmPagePath(joinId), expiresAt: record.expiresAt };
    return json(result, 201);
  });
  const poll = guarded('GET', async request => {
    const auth = await authenticate(request);
    if (!auth) return error('not_found', 404);
    const { record, revision } = auth;
    const state = effectiveState(record, deps.clock());
    if (state !== 'confirmed') return json({ state: state === 'ready' ? 'claimed' : state });
    const credentials = openCredentials(deps.secret, record.joinId, record.sealedCredentials ?? '');
    if (!credentials) return error('unavailable', 503);
    const next = { ...record, state: 'claimed' as const }; delete next.sealedCredentials;
    const write = await deps.joins.replace(record.joinId, revision, next, 'claim');
    if (write.kind === 'applied') return json({ state: 'confirmed', credentials });
    if (write.kind === 'conflict') {
      const read = await deps.joins.read(record.joinId);
      if (read.kind === 'found' && (read.record.state === 'claimed' || read.record.state === 'ready')) return json({ state: 'claimed' });
    }
    return error('unavailable', 503);
  });
  const ready = guarded('POST', async request => {
    const auth = await authenticate(request);
    if (!auth) return error('not_found', 404);
    const { record, revision } = auth;
    const state = effectiveState(record, deps.clock());
    if (state === 'ready') return empty();
    if (state !== 'claimed') return error('not_confirmed', 409);
    const write = await deps.joins.replace(record.joinId, revision, { ...record, state: 'ready' }, 'ready');
    if (write.kind === 'applied') return empty();
    if (write.kind === 'conflict') {
      const read = await deps.joins.read(record.joinId);
      if (read.kind === 'found' && read.record.state === 'ready') return empty();
    }
    return error('unavailable', 503);
  });
  return { create, poll, ready };
}
