import { createHash } from 'node:crypto';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { decodeRoomId, type ControlStore, type RoomId } from '@khala/contracts/messaging/index';
import type { AgentProvisioner } from './provision';
import { readRoomRemovals } from '../invitations/removals';

const key = (token: string) => `agent-session-status.v1.${createHash('sha256').update(token).digest('hex')}`;
type SessionIndex = Readonly<{ v: 1; userId: string; roomId: string; generation: number }>;
export const AGENT_SESSION_STATUS_PATH = '/api/agent/session/status';
export async function rememberAgentSession(store: ControlStore, credentials: AgentCredentials, issuedGeneration?: number): Promise<boolean> {
  const removals = await readRoomRemovals(store, credentials.roomId as RoomId);
  if (removals === 'unavailable') return false;
  const read = await store.read<SessionIndex>(key(credentials.accessToken));
  if (read.kind === 'unavailable') return false;
  if (read.kind === 'record') return read.record.value.userId === credentials.userId && read.record.value.roomId === credentials.roomId;
  const value: SessionIndex = { v: 1, userId: credentials.userId, roomId: credentials.roomId, generation: issuedGeneration ?? removals?.generation ?? 0 };
  const written = await store.compareAndSet({ key: key(credentials.accessToken), expectedRevision: null,
    operationId: `agent-session.${createHash('sha256').update(credentials.accessToken).digest('hex')}`,
    next: { value, expiresAt: null } });
  return written.kind === 'applied' || written.kind === 'conflict' && written.current?.value.userId === credentials.userId;
}
export function createAgentSessionStatusHandler(store: ControlStore, options?: Readonly<{ homeserverOrigin: string; fetch?: typeof globalThis.fetch }>) {
  return async (request: Request): Promise<Response> => {
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const query = new URL(request.url).searchParams;
    const roomId = decodeRoomId(query.get('roomId')); const userId = query.get('userId');
    const claimedIdentity = roomId.ok && typeof userId === 'string' && /^@[^\s:]{1,255}:[^\s]{1,255}$/u.test(userId) ? { roomId: roomId.value, userId } : null;
    if ([...query.keys()].some(key => key !== 'roomId' && key !== 'userId') || (query.size > 0 && (query.size !== 2 || !claimedIdentity))) return json(400, { error: 'invalid_request' });
    const token = /^Bearer ([^\s]{1,4096})$/u.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return json(401, { error: 'authentication_required' });
    try {
      const read = await store.read<SessionIndex>(key(token));
      if (read.kind === 'unavailable') return json(503, { error: 'unavailable' });
      if (read.kind === 'absent') {
        if (!claimedIdentity) return json(200, { removed: false });
        const removals = await readRoomRemovals(store, claimedIdentity.roomId);
        if (removals === 'unavailable') return json(503, { error: 'unavailable' });
        const entry = removals ? Object.values(removals.owners).find(entry => entry.agents.includes(claimedIdentity.userId)) : undefined;
        if (!entry) return json(200, { removed: false });
        if (options) {
          const fetch = options.fetch ?? globalThis.fetch;
          const response = await fetch(`${options.homeserverOrigin}/_matrix/client/v3/account/whoami`,
            { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
          if (response.ok) {
            const value = await response.json() as { user_id?: unknown; device_id?: unknown };
            if (value.user_id !== claimedIdentity.userId) return json(200, { removed: false });
            if (!entry.complete) return json(200, { removed: true });
            // A valid token after completed logout/all is a fresh authorized issuance.
            const remembered = await rememberAgentSession(store, { homeserver: options.homeserverOrigin,
              userId: claimedIdentity.userId, roomId: claimedIdentity.roomId, accessToken: token, deviceId: typeof value.device_id === 'string' ? value.device_id : 'unknown' });
            return remembered ? json(200, { removed: false }) : json(503, { error: 'unavailable' });
          }
          if (response.status !== 401) return json(503, { error: 'unavailable' });
        }
        // Legacy bearer indexes were not retained. This reveals only a removal boolean
        // for the exact agent and room already recorded in the removal ledger.
        return json(200, { removed: true });
      }
      const session = read.record.value;
      if (claimedIdentity && (session.userId !== claimedIdentity.userId || session.roomId !== claimedIdentity.roomId)) return json(200, { removed: false });
      if (session.v !== 1 || typeof session.roomId !== 'string' || typeof session.userId !== 'string' || !Number.isSafeInteger(session.generation)) return json(503, { error: 'unavailable' });
      const removals = await readRoomRemovals(store, session.roomId as RoomId);
      if (removals === 'unavailable') return json(503, { error: 'unavailable' });
      const removed = removals ? Object.values(removals.owners).some(entry => entry.generation > session.generation && entry.agents.includes(session.userId)) : false;
      return json(200, { removed });
    } catch { return json(503, { error: 'unavailable' }); }
  };
}

const roomAgentsKey = (roomId: RoomId, ownerId: string) => `room-agents.v1.${createHash('sha256').update(JSON.stringify([roomId, ownerId])).digest('hex')}`;
type RoomAgents = Readonly<{ v: 1; roomId: string; ownerId: string; agents: readonly string[] }>;
export async function roomAgents(store: ControlStore, roomId: RoomId, ownerId: string): Promise<readonly string[] | 'unavailable'> {
  const read = await store.read<RoomAgents>(roomAgentsKey(roomId, ownerId));
  if (read.kind === 'absent') return [];
  if (read.kind !== 'record') return 'unavailable';
  const value = read.record.value;
  return value.v === 1 && value.roomId === roomId && value.ownerId === ownerId && Array.isArray(value.agents)
    && value.agents.every(agent => typeof agent === 'string') ? value.agents : 'unavailable';
}
/** Authenticated confirmation registers the room binding before minting any token. */
export async function rememberRoomAgent(store: ControlStore, roomId: RoomId, ownerId: string, userId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = await store.read<RoomAgents>(roomAgentsKey(roomId, ownerId));
    if (read.kind === 'unavailable') return false;
    const agents = read.kind === 'record' ? read.record.value.agents : [];
    if (!Array.isArray(agents)) return false;
    if (agents.includes(userId)) return true;
    const value: RoomAgents = { v: 1, roomId, ownerId, agents: [...agents, userId] };
    const result = await store.compareAndSet({ key: roomAgentsKey(roomId, ownerId), expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `room-agent.${createHash('sha256').update(JSON.stringify([roomId, ownerId, userId, read.kind === 'record' ? read.record.revision : null])).digest('hex')}`,
      next: { value, expiresAt: null } });
    if (result.kind === 'applied') return true;
    if (result.kind !== 'conflict') return false;
  }
  return false;
}


export const AGENT_SESSION_RESUME_PATH = '/api/agent/session/resume';
/** Only a still-valid indexed bearer can mint a fresh ephemeral crypto device. */
export function createAgentSessionResumeHandler(store: ControlStore, options: {
  homeserverOrigin: string; provisioner: AgentProvisioner; fetch?: typeof globalThis.fetch;
}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const status = createAgentSessionStatusHandler(store);
  return async (request: Request): Promise<Response> => {
    const json = (code: number, value: unknown) => new Response(JSON.stringify(value), { status: code,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const token = /^Bearer ([^\s]{1,4096})$/u.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return json(401, { error: 'authentication_required' });
    let issued: AgentCredentials | undefined;
    let delivered = false;
    try {
      const read = await store.read<SessionIndex>(key(token));
      if (read.kind === 'unavailable') return json(503, { error: 'unavailable' });
      if (read.kind !== 'record') return json(401, { error: 'unauthorized' });
      const session = read.record.value;
      if (session.v !== 1 || !decodeRoomId(session.roomId).ok || typeof session.userId !== 'string' || !Number.isSafeInteger(session.generation)) return json(503, { error: 'unavailable' });
      const check = async () => {
        const response = await status(new Request(new URL(AGENT_SESSION_STATUS_PATH, request.url), { headers: { authorization: `Bearer ${token}` } }));
        if (!response.ok) return 'unavailable';
        return (await response.json() as { removed: boolean }).removed ? 'removed' : 'ok';
      };
      const before = await check();
      if (before !== 'ok') return json(before === 'removed' ? 403 : 503, { error: before });
      const whoami = await fetch(`${options.homeserverOrigin}/_matrix/client/v3/account/whoami`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (whoami.status === 401) return json(401, { error: 'unauthorized' });
      if (!whoami.ok) return json(503, { error: 'unavailable' });
      if ((await whoami.json() as { user_id?: unknown }).user_id !== session.userId) return json(401, { error: 'unauthorized' });
      const result = await options.provisioner.resume?.({ userId: session.userId, roomId: session.roomId });
      if (result?.kind !== 'ok') return json(503, { error: 'unavailable' });
      issued = result.credentials;
      // Keep the original generation: a concurrent removal must invalidate this device too.
      if (!await rememberAgentSession(store, result.credentials, session.generation)) return json(503, { error: 'unavailable' });
      const after = await check();
      if (after !== 'ok') return json(after === 'removed' ? 403 : 503, { error: after });
      delivered = true;
      return json(200, result.credentials);
    } catch { return json(503, { error: 'unavailable' }); }
    finally {
      if (issued && !delivered) await fetch(`${options.homeserverOrigin}/_matrix/client/v3/logout`, { method: 'POST',
        headers: { authorization: `Bearer ${issued.accessToken}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }
  };
}
