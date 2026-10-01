import { decodeClosureRequest, decodeClosureStatus, decodeRoomId, type AuthPrincipal, type ClosurePort, type ClosureRequest, type ClosureStatus, type OperationResult } from '@khala/contracts/messaging/index';
import type { AuthService, MutationAuthorization } from '../auth/index';
import type { RouteRegistration } from '../runtime/handler';

export const CLOSURE_PATH = '/api/human/channel-closure';

type Dependencies = Readonly<{
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  service(principal: AuthPrincipal): ClosurePort;
  cleanupRequests?(principal: AuthPrincipal): Promise<Readonly<{ kind: 'ok'; requests: readonly ClosureRequest[] }> | Readonly<{ kind: 'unavailable' }>>;
  diagnostic?(stage: 'authentication_unavailable' | 'cleanup_unavailable' | 'cleanup_rejected'): void;
}>;

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const failure = (status: number, code: string) => json(status, { code });

function diagnose(deps: Dependencies, stage: 'authentication_unavailable' | 'cleanup_unavailable' | 'cleanup_rejected'): void {
  try { deps.diagnostic?.(stage); } catch { /* Diagnostics cannot change the response. */ }
}

function denied(result: Exclude<MutationAuthorization, { kind: 'authorized' }>): Response {
  if (result.kind === 'unavailable') return failure(503, 'unavailable');
  switch (result.code) {
    case 'signed_out': return failure(401, 'authentication_required');
    case 'not_a_mutation': return failure(405, 'method_not_allowed');
    case 'forbidden_origin': return failure(403, 'forbidden_origin');
    case 'csrf_mismatch': return failure(403, 'csrf_mismatch');
  }
}

async function body(request: Request): Promise<unknown> {
  if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return null;
  try { return await request.json(); } catch { return null; }
}

function status(result: OperationResult<ClosureStatus, string>): Response {
  if (result.kind === 'ok') {
    const decoded = decodeClosureStatus(result.value);
    return decoded.ok ? json(200, { kind: 'ok', value: decoded.value }) : failure(503, 'unavailable');
  }
  if (result.kind === 'outcome_unknown') return json(502, { code: 'outcome_unknown', operationId: result.operationId });
  if (result.kind === 'unavailable') return failure(503, 'unavailable');
  return failure(result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 409, result.code);
}

/** Register only under the exact human API path; no agent or Matrix-message route exists. */
export function createChannelClosureHandlers(deps: Dependencies): readonly RouteRegistration[] {
  return [{
    path: CLOSURE_PATH,
    methods: ['GET', 'POST'],
    async handle(request) {
      if (request.method === 'POST') {
        // Authorization precedes body parsing and service construction. The OIDC
        // service checks exact Origin, fetch metadata, session and CSRF.
        const authorization = await deps.auth.requireHumanMutation(request).catch(() => ({ kind: 'unavailable' as const }));
        if (authorization.kind !== 'authorized') return denied(authorization);
        const input = decodeClosureRequest(await body(request));
        if (!input.ok) return failure(400, 'invalid_request');
        if (input.value.ownerId !== authorization.context.principal.ownerId) return failure(403, 'forbidden');
        return status(await deps.service(authorization.context.principal).closeRoom(input.value));
      }

      const authentication = await deps.auth.authenticateRequest(request).catch(() => ({ kind: 'unavailable' as const }));
      if (authentication.kind === 'unavailable') {
        diagnose(deps, 'authentication_unavailable');
        return failure(503, 'unavailable');
      }
      if (authentication.kind !== 'authenticated') return failure(401, 'authentication_required');
      const query = new URL(request.url).searchParams;
      const operationId = query.get('operationId');
      const room = query.get('roomId');
      if (query.size === 1 && query.get('cleanup') === '1') {
        let result: Awaited<ReturnType<NonNullable<Dependencies['cleanupRequests']>>> | undefined;
        try { result = await deps.cleanupRequests?.(authentication.context.principal); }
        catch {
          diagnose(deps, 'cleanup_rejected');
          return failure(503, 'unavailable');
        }
        if (result?.kind !== 'ok') diagnose(deps, 'cleanup_unavailable');
        return result?.kind === 'ok' ? json(200, { kind: 'ok', value: result.requests }) : failure(503, 'unavailable');
      }
      if (query.size !== 1 || (operationId === null && room === null)) return failure(400, 'invalid_request');
      const service = deps.service(authentication.context.principal);
      if (operationId !== null && operationId.length > 0) {
        const result = await service.inspectClosure(operationId);
        if (result.kind === 'rejected' && result.code === 'not_found') return failure(404, 'not_found');
        if (result.kind === 'rejected' && result.code === 'forbidden') return failure(403, 'forbidden');
        return status(result);
      }
      const decoded = decodeRoomId(room);
      if (!decoded.ok) return failure(400, 'invalid_request');
      const result = await service.capability(decoded.value);
      if (result.kind === 'ok') return json(200, { kind: 'ok', value: result.value });
      return result.kind === 'rejected' ? failure(403, 'forbidden') : failure(503, 'unavailable');
    },
  }];
}
