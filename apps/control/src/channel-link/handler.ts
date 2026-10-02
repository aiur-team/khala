import {
  decodeHumanChannelLinkResolveRequest, decodePersonalChannelLinkRequest,
} from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth';
import type { AdmissionService } from '../invitations';
import { inviteFromShareLink } from '../invitations/link';
import type { ControlStore } from '@khala/contracts/messaging/index';
import type { RouteRegistration } from '../runtime/handler';

export const HUMAN_CHANNEL_LINK_RESOLVE_PATH = '/api/human/channel-link/resolve';
export const HUMAN_CHANNEL_LINK_PERSONAL_PATH = '/api/human/channel-link/personal';
export function createChannelLinkHandlers(deps: Readonly<{
  origin: string;
  store: ControlStore;
  secret: string;
  clock: () => number;
  auth?: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  admissionFor?(request: Request): AdmissionService;
}>): Readonly<{ human: readonly RouteRegistration[] }> {
  async function resolveHuman(request: Request): Promise<Response> {
    const humanAuth = deps.auth;
    const admissionFor = deps.admissionFor;
    if (!humanAuth || !admissionFor) return result(503, 'unavailable');
    const auth = await safe(() => humanAuth.authenticateRequest(request));
    if (!auth || auth.kind === 'unavailable') return result(503, 'unavailable');
    if (auth.kind === 'signed_out') return result(401, 'auth_required');
    const body = await readBody(request, ['v', 'channelUrl']);
    const decoded = decodeHumanChannelLinkResolveRequest(body, deps.origin);
    if (!decoded.ok) return result(400, 'invalid_link');
    const url = new URL(decoded.value.channelUrl);
    const invite = inviteFromShareLink(url, deps.origin);
    if (invite === null) return result(400, 'invalid_link');
    const state = await safe(() => admissionFor(request).inspect(invite));
    if (!state || state === 'unavailable') return result(503, 'unavailable');
    if (state === 'auth_required') return result(401, 'auth_required');
    if (state === 'eligible') return result(200, 'join_required');
    if (state === 'already_joined') return result(200, 'joined');
    if (state === 'identity_mismatch') return result(403, 'forbidden');
    return result(410, state);
  }

  async function personalHuman(request: Request): Promise<Response> {
    const humanAuth = deps.auth;
    const admissionFor = deps.admissionFor;
    if (!humanAuth || !admissionFor) return result(503, 'unavailable');
    const auth = await safe(() => humanAuth.requireHumanMutation(request));
    if (!auth || auth.kind === 'unavailable') return result(503, 'unavailable');
    if (auth.kind === 'rejected') return result(auth.code === 'signed_out' ? 401 : 403,
      auth.code === 'signed_out' ? 'auth_required' : 'forbidden');
    const body = await readBody(request, ['v', 'roomId']);
    const decoded = decodePersonalChannelLinkRequest(body);
    if (!decoded.ok) return result(400, 'invalid_link');
    const shared = await safe(() => admissionFor(request).personalLink(decoded.value.roomId));
    if (!shared || shared.kind === 'unavailable') return result(503, 'unavailable');
    if (shared.kind === 'outcome_unknown') return result(503, 'unavailable');
    if (shared.kind === 'rejected') {
      if (shared.code === 'expired' || shared.code === 'revoked') return result(410, shared.code);
      return result(shared.code === 'auth_required' ? 401 : 403,
        shared.code === 'auth_required' ? 'auth_required' : 'forbidden');
    }
    return json(200, { v: 1, kind: 'personal_link', shareUrl: shared.value.shareUrl, expiresAt: shared.value.expiresAt });
  }

  return Object.freeze({
    human: Object.freeze(deps.auth && deps.admissionFor ? [
      { path: HUMAN_CHANNEL_LINK_RESOLVE_PATH, methods: ['POST'], handle: resolveHuman },
      { path: HUMAN_CHANNEL_LINK_PERSONAL_PATH, methods: ['POST'], handle: personalHuman },
    ] : []),
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

function result(status: number, kind: string): Response { return json(status, { v: 1, kind }); }
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
