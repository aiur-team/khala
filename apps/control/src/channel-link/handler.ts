import {
  decodeChannelAccessRequest, decodeRoomId,
  type AccessRequestStatus, type ChannelAccessRequesterContext,
  type DiscoveryRequester, type OwnerId, type RoomId,
} from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth';
import type { AdmissionService } from '../invitations';
import { inviteFromShareLink, resolveAgentChannelLink } from '../invitations/link';
import type { GatewayInspection } from '../invitations';
import type { ControlStore } from '@khala/contracts/messaging/index';
import type { RouteRegistration } from '../runtime/handler';

export const HUMAN_CHANNEL_LINK_RESOLVE_PATH = '/api/human/channel-link/resolve';
export const HUMAN_CHANNEL_LINK_PERSONAL_PATH = '/api/human/channel-link/personal';
export const AGENT_CHANNEL_LINK_REQUEST_PATH = '/api/agent/channel-link/request';

export type AgentLinkAuthentication =
  | Readonly<{ kind: 'authenticated'; credentialRef: string; sponsorOwnerId: OwnerId; requester: DiscoveryRequester; context: ChannelAccessRequesterContext }>
  | Readonly<{ kind: 'rejected'; code: 'auth_required' | 'forbidden' }>
  | Readonly<{ kind: 'unavailable' }>;

export function createChannelLinkHandlers(deps: Readonly<{
  origin: string;
  store: ControlStore;
  secret: string;
  clock: () => number;
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  admissionFor(request: Request): AdmissionService;
  agent?: Readonly<{
    authenticate(request: Request): Promise<AgentLinkAuthentication>;
    inspectMembership(ownerId: OwnerId, roomId: RoomId): Promise<GatewayInspection>;
    /** Must recheck the invite revision before creating the journal row. */
    submitAccess(input: Readonly<{
      operationId: string; credentialRef: string; channelUrl: string;
      roomId: RoomId; inviteRevision: string; sponsorOwnerId: OwnerId;
      requester: DiscoveryRequester; context: ChannelAccessRequesterContext;
    }>): Promise<AccessRequestStatus>;
  }>;
}>): Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[] }> {
  async function resolveHuman(request: Request): Promise<Response> {
    const auth = await safe(() => deps.auth.authenticateRequest(request));
    if (!auth || auth.kind === 'unavailable') return result(503, 'unavailable');
    if (auth.kind === 'signed_out') return result(401, 'auth_required');
    const body = await readBody(request, ['v', 'channelUrl']);
    if (!body || body.v !== 1 || typeof body.channelUrl !== 'string') return result(400, 'invalid_link');
    let url: URL;
    try { url = new URL(body.channelUrl); } catch { return result(400, 'invalid_link'); }
    const invite = inviteFromShareLink(url, deps.origin);
    if (invite === null) return result(400, 'invalid_link');
    const state = await safe(() => deps.admissionFor(request).inspect(invite));
    if (!state || state === 'unavailable') return result(503, 'unavailable');
    if (state === 'auth_required') return result(401, 'auth_required');
    if (state === 'eligible') return result(200, 'join_required');
    if (state === 'already_joined') return result(200, 'joined');
    if (state === 'identity_mismatch') return result(403, 'forbidden');
    return result(410, state);
  }

  async function personalHuman(request: Request): Promise<Response> {
    const auth = await safe(() => deps.auth.requireHumanMutation(request));
    if (!auth || auth.kind === 'unavailable') return result(503, 'unavailable');
    if (auth.kind === 'rejected') return result(auth.code === 'signed_out' ? 401 : 403,
      auth.code === 'signed_out' ? 'auth_required' : 'forbidden');
    const body = await readBody(request, ['v', 'roomId']);
    const room = decodeRoomId(body?.roomId);
    if (!body || body.v !== 1 || !room.ok) return result(400, 'invalid_link');
    const shared = await safe(() => deps.admissionFor(request).personalLink(room.value));
    if (!shared || shared.kind === 'unavailable') return result(503, 'unavailable');
    if (shared.kind === 'outcome_unknown') return result(503, 'unavailable');
    if (shared.kind === 'rejected') {
      if (shared.code === 'expired' || shared.code === 'revoked') return result(410, shared.code);
      return result(shared.code === 'auth_required' ? 401 : 403,
        shared.code === 'auth_required' ? 'auth_required' : 'forbidden');
    }
    return json(200, { v: 1, kind: 'personal_link', shareUrl: shared.value.shareUrl, expiresAt: shared.value.expiresAt });
  }

  async function requestAgent(request: Request): Promise<Response> {
    const agent = deps.agent;
    if (!agent) return result(503, 'unavailable');
    const auth = await safe(() => agent.authenticate(request));
    if (!auth || auth.kind === 'unavailable') return result(503, 'unavailable');
    if (auth.kind === 'rejected') return result(auth.code === 'auth_required' ? 401 : 403, auth.code);
    const body = await readBody(request, ['v', 'kind', 'operationId', 'credentialRef', 'channelUrl']);
    const decoded = decodeChannelAccessRequest(body, auth.requester.origin);
    if (!decoded.ok || decoded.value.kind !== 'channel_url') return result(400, 'invalid_link');
    const access = decoded.value;
    if (access.credentialRef !== auth.credentialRef) return result(403, 'forbidden');
    const resolved = await resolveAgentChannelLink({
      channelUrl: access.channelUrl, origin: deps.origin, store: deps.store,
      secret: deps.secret, clock: deps.clock, sponsorOwnerId: auth.sponsorOwnerId,
      requester: auth.requester, context: auth.context, inspectMembership: agent.inspectMembership,
    });
    if (resolved.kind === 'use_your_link') return json(409, {
      v: 1, kind: 'use_your_link', action: 'join_in_browser_then_copy_your_link',
    });
    if (resolved.kind !== 'resolved') return result(statusFor(resolved.kind), resolved.kind);
    const submitted = await safe(() => agent.submitAccess({
      operationId: access.operationId, credentialRef: access.credentialRef,
      channelUrl: access.channelUrl, roomId: resolved.roomId, inviteRevision: resolved.revision,
      sponsorOwnerId: auth.sponsorOwnerId, requester: auth.requester, context: auth.context,
    }));
    if (!submitted) return result(503, 'unavailable');
    return json(200, { v: 1, kind: 'request', operationId: submitted.operationId, outcome: submitted.outcome });
  }

  return Object.freeze({
    human: Object.freeze([
      { path: HUMAN_CHANNEL_LINK_RESOLVE_PATH, methods: ['POST'], handle: resolveHuman },
      { path: HUMAN_CHANNEL_LINK_PERSONAL_PATH, methods: ['POST'], handle: personalHuman },
    ]),
    agent: Object.freeze(deps.agent ? [{ path: AGENT_CHANNEL_LINK_REQUEST_PATH, methods: ['POST'], handle: requestAgent }] : []),
  });
}

async function readBody(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | null> {
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  try {
    const value: unknown = await request.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key)) ? record : null;
  } catch { return null; }
}

async function safe<T>(call: () => Promise<T>): Promise<T | null> {
  try { return await call(); } catch { return null; }
}

function statusFor(kind: string): number {
  return kind === 'invalid_link' ? 400 : kind === 'forbidden' ? 403
    : kind === 'expired' || kind === 'revoked' ? 410 : 503;
}

function result(status: number, kind: string): Response { return json(status, { v: 1, kind }); }
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
