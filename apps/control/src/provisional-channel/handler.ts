import type { OwnerId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth';
import type { RouteRegistration } from '../runtime/handler';
import type { createProvisionalChannelStore } from './store';

export const PROVISIONAL_CREATE_PATH = '/api/agent/provisional-channels';
export const PROVISIONAL_CLAIM_PATH = '/api/human/provisional-channels/claim';

type Journal = ReturnType<typeof createProvisionalChannelStore>;
type Session = Parameters<Journal['start']>[0];

/** The session verifier is the installed native adapter, never a JSON claim. */
export function createProvisionalChannelHandlers(deps: Readonly<{
  journal: Journal;
  auth: Pick<AuthService, 'requireHumanMutation'>;
  sessionFor(request: Request): Promise<Session | 'unsupported' | 'unavailable'>;
  origin: string;
  claimUrl(token: string): string;
}>): Readonly<{ agent: RouteRegistration; human: RouteRegistration }> {
  const agent: RouteRegistration = {
    path: PROVISIONAL_CREATE_PATH, methods: ['POST'],
    async handle(request) {
      try {
        const session = await deps.sessionFor(request);
        if (session === 'unavailable') return rejected(503, 'native_session_unavailable');
        if (session === 'unsupported') return rejected(403, 'unsupported_session');
        const result = await deps.journal.start(session);
        if (result.kind === 'provisional') {
          const claimUrl = deps.claimUrl(result.claimToken);
          const url = URL.canParse(claimUrl) ? new URL(claimUrl) : null;
          if (url?.protocol !== 'https:' || url.origin !== deps.origin || url.username || url.password) {
            return rejected(503, 'claim_route_unavailable');
          }
          return json(200, { v: 1, state: 'provisional',
            channelId: result.channelId, claimUrl, expiresAt: result.expiresAt });
        }
        if (result.kind === 'already_claimed') return json(200, { v: 1, state: 'claimed', channelId: result.channelId });
        return rejected(result.kind === 'invalid' ? 400 : 503, result.kind);
      } catch { return rejected(503, 'unavailable'); }
    },
  };
  const human: RouteRegistration = {
    path: PROVISIONAL_CLAIM_PATH, methods: ['POST'],
    async handle(request) {
      try {
        const authorization = await deps.auth.requireHumanMutation(request);
        if (authorization.kind === 'unavailable') return rejected(503, 'unavailable');
        if (authorization.kind === 'rejected') return rejected(authorization.code === 'signed_out' ? 401 : 403,
          authorization.code);
        const token = await claimToken(request);
        if (token === null) return rejected(400, 'invalid_request');
        const ownerId: OwnerId = authorization.context.principal.ownerId;
        const result = await deps.journal.claim(token, ownerId);
        if (result.kind === 'claimed') return json(200, { v: 1, state: 'claimed',
          channelId: result.channelId, repeated: result.repeated });
        const status = result.kind === 'conflict' ? 409 : result.kind === 'expired' ? 410
          : result.kind === 'invalid' ? 400 : 503;
        return rejected(status, result.kind);
      } catch { return rejected(503, 'unavailable'); }
    },
  };
  return Object.freeze({ agent, human });
}

async function claimToken(request: Request): Promise<string | null> {
  if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return null;
  let value: unknown;
  try { value = await request.json(); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.claimToken === 'string' && body.claimToken.length <= 256
    ? body.claimToken : null;
}

function rejected(status: number, code: string): Response {
  return json(status, { v: 1, kind: 'rejected', code });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } });
}
