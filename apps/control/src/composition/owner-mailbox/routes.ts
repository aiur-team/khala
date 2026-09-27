import type { AuthPrincipal, BindingId, ControlStore, JsonValue, OwnerId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import type { AdmissionGateway } from '../../invitations/index';
import type { RouteRegistration } from '../../runtime/handler';
import { createOwnerMailbox, type OwnerCommandKind, type OwnerMailboxCommand } from './store';

export const OWNER_MAILBOX_SUBMIT = '/api/human/owner-mailbox/submit';
export const OWNER_MAILBOX_RESULT = '/api/human/owner-mailbox/result';
export const OWNER_MAILBOX_POLL = '/api/agent/owner-mailbox/poll';
export const OWNER_MAILBOX_COMPLETE = '/api/agent/owner-mailbox/complete';

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
function unavailable(): Response { return json(503, { code: 'unavailable' }); }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function readCommand(value: unknown): (OwnerMailboxCommand & { bindingId: string }) | null {
  if (!plain(value) || !exact(value, ['bindingId', 'operationId', 'kind', 'body'])
    || typeof value.bindingId !== 'string' || typeof value.operationId !== 'string'
    || !['controls_status', 'controls_set', 'review_preview', 'review_approve'].includes(String(value.kind))) return null;
  return value as OwnerMailboxCommand & { bindingId: string };
}
function readCompletion(value: unknown): { bindingId: string; operationId: string; outcome: JsonValue } | null {
  const encoded = plain(value) ? JSON.stringify(value.outcome) : undefined;
  if (!plain(value) || !exact(value, ['bindingId', 'operationId', 'outcome'])
    || typeof value.bindingId !== 'string' || typeof value.operationId !== 'string'
    || typeof encoded !== 'string' || encoded.length > 32_768) return null;
  return value as { bindingId: string; operationId: string; outcome: JsonValue };
}

export function createOwnerMailboxRoutes(input: Readonly<{
  auth: AuthService;
  gateway: AdmissionGateway;
  store: ControlStore;
  capabilities: AdapterCapabilities;
  clock: () => number;
  authoritySecret: string;
  inspectOwnerMembership(ownerId: OwnerId, roomId: RoomId): Promise<Readonly<{ kind: 'joined' | 'absent' | 'unavailable' }>>;
}>): Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[] }> {
  const bindings = createAgentBindingStore({ store: input.store });
  async function owner(request: Request, bindingId: string, mutate: boolean): Promise<
    Readonly<{ principal: AuthPrincipal; binding: SessionBinding; roomId: RoomId }> | Response
  > {
    const signed = mutate ? await input.auth.requireHumanMutation(request) : await input.auth.authenticateRequest(request);
    if (signed.kind === 'unavailable') return unavailable();
    if (signed.kind !== 'authorized' && signed.kind !== 'authenticated') {
      return json(signed.kind === 'signed_out' || ('code' in signed && signed.code === 'signed_out') ? 401 : 403,
        { code: 'owner_auth_required' });
    }
    const principal = signed.context.principal;
    const found = await bindings.locateBinding(bindingId as BindingId);
    if (found.kind === 'unavailable') return unavailable();
    if (found.kind !== 'found' || found.record.revokedGeneration !== null
      || found.record.binding.ownerId !== principal.ownerId) return json(403, { code: 'forbidden' });
    const membership = await input.gateway.inspectMembership({ roomId: found.address.roomId, principal, history: 'none' });
    if (membership.kind === 'unavailable') return unavailable();
    if (membership.kind !== 'joined') return json(403, { code: 'forbidden' });
    return { principal, binding: found.record.binding, roomId: found.address.roomId };
  }
  async function agent(request: Request, action: 'receive_released' | 'ack_delivery') {
    const authorized = await input.capabilities.authorize(request, action);
    if (authorized.kind === 'unavailable') return unavailable();
    if (authorized.kind === 'refused') return json(authorized.status, { code: authorized.code });
    const membership = await input.inspectOwnerMembership(authorized.ownerId, authorized.roomId);
    if (membership.kind === 'unavailable') return unavailable();
    if (membership.kind !== 'joined') return json(403, { code: 'owner_membership_required' });
    return { binding: authorized.binding, roomId: authorized.roomId };
  }
  return {
    human: Object.freeze([
      { path: OWNER_MAILBOX_SUBMIT, methods: ['POST'], async handle(request: Request) {
        let body: ReturnType<typeof readCommand> = null;
        try { body = readCommand(await request.json()); } catch { /* malformed */ }
        if (!body) return json(400, { code: 'invalid_request' });
        const authority = await owner(request, body.bindingId, true);
        if (authority instanceof Response) return authority;
        const mailbox = createOwnerMailbox({ store: input.store, binding: authority.binding, roomId: authority.roomId, clock: input.clock, authoritySecret: input.authoritySecret });
        const result = await mailbox.submit({ operationId: body.operationId, kind: body.kind as OwnerCommandKind, body: body.body }, authority.principal);
        return result.kind === 'ok' ? json(200, { v: 1, operationId: result.value.operationId, outcome: result.value.outcome })
          : result.kind === 'conflict' ? json(409, { code: 'operation_conflict' }) : unavailable();
      } },
      { path: OWNER_MAILBOX_RESULT, methods: ['GET'], async handle(request: Request) {
        const url = new URL(request.url);
        const bindingId = url.searchParams.get('binding_id');
        const operationId = url.searchParams.get('operation_id');
        if (!bindingId || !operationId || [...url.searchParams.keys()].sort().join(',') !== 'binding_id,operation_id') {
          return json(400, { code: 'invalid_request' });
        }
        const authority = await owner(request, bindingId, false);
        if (authority instanceof Response) return authority;
        const result = await createOwnerMailbox({ store: input.store, binding: authority.binding, roomId: authority.roomId, clock: input.clock, authoritySecret: input.authoritySecret }).result(operationId);
        if (result.kind === 'conflict') return json(400, { code: 'invalid_request' });
        if (result.kind !== 'ok') return unavailable();
        return result.value === null ? json(404, { code: 'not_found' })
          : json(200, { v: 1, operationId: result.value.operationId, outcome: result.value.outcome });
      } },
    ] satisfies RouteRegistration[]),
    agent: Object.freeze([
      { path: OWNER_MAILBOX_POLL, methods: ['GET'], async handle(request: Request) {
        const identity = await agent(request, 'receive_released');
        if (identity instanceof Response) return identity;
        const result = await createOwnerMailbox({ store: input.store, ...identity, clock: input.clock, authoritySecret: input.authoritySecret }).pending();
        return result.kind === 'ok' ? json(200, { v: 1, bindingId: identity.binding.bindingId,
          generation: identity.binding.generation, entries: result.value.map(entry => ({
            operationId: entry.operationId, kind: entry.kind, body: entry.body, authority: entry.authority,
            outcome: entry.outcome,
          })) }) : unavailable();
      } },
      { path: OWNER_MAILBOX_COMPLETE, methods: ['POST'], async handle(request: Request) {
        const identity = await agent(request, 'ack_delivery');
        if (identity instanceof Response) return identity;
        let body: ReturnType<typeof readCompletion> = null;
        try { body = readCompletion(await request.json()); } catch { /* malformed */ }
        if (!body || body.bindingId !== identity.binding.bindingId) return json(400, { code: 'invalid_request' });
        const result = await createOwnerMailbox({ store: input.store, ...identity, clock: input.clock, authoritySecret: input.authoritySecret }).complete(body.operationId, body.outcome);
        return result.kind === 'ok' ? json(200, { v: 1, operationId: result.value.operationId })
          : result.kind === 'conflict' ? json(409, { code: 'operation_conflict' }) : unavailable();
      } },
    ] satisfies RouteRegistration[]),
  };
}

/** Stable route inventory even when operator admission mode is disabled. */
export function unavailableOwnerMailboxRoutes(): Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[] }> {
  const absent = (path: string, method: string): RouteRegistration => Object.freeze({
    path, methods: Object.freeze([method]), handle: async () => unavailable(),
  });
  return { human: [absent(OWNER_MAILBOX_SUBMIT, 'POST'), absent(OWNER_MAILBOX_RESULT, 'GET')],
    agent: [absent(OWNER_MAILBOX_POLL, 'GET'), absent(OWNER_MAILBOX_COMPLETE, 'POST')] };
}

/** Generated gateway metadata is static; live stores and auth load only per request. */
export function createLazyOwnerMailboxRoutes(load: () => ReturnType<typeof createOwnerMailboxRoutes>): ReturnType<typeof createOwnerMailboxRoutes> {
  const defaults = unavailableOwnerMailboxRoutes();
  const bind = (routes: readonly RouteRegistration[], domain: 'human' | 'agent'): readonly RouteRegistration[] =>
    routes.map((route, index) => ({ path: route.path, methods: route.methods,
      handle: (request: Request) => load()[domain][index]!.handle(request) }));
  return { human: bind(defaults.human, 'human'), agent: bind(defaults.agent, 'agent') };
}
