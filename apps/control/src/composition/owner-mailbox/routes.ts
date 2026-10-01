import type { AuthPrincipal, BindingId, ControlStore, JsonValue, OwnerId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../invitations/index';
import type { RouteRegistration } from '../../runtime/handler';
import { createOwnerMailbox, type MailboxSubmitDiagnostic, type OwnerCommandKind, type OwnerMailboxCommand } from './store';

export const OWNER_MAILBOX_SUBMIT = '/api/human/owner-mailbox/submit';
export const OWNER_MAILBOX_RESULT = '/api/human/owner-mailbox/result';
export const OWNER_REVIEW_BINDINGS = '/api/human/owner-mailbox/review-bindings';
export const OWNER_REVIEW_STATUS = '/api/human/owner-mailbox/review-status';
export const OWNER_MAILBOX_POLL = '/api/agent/owner-mailbox/poll';
export const OWNER_MAILBOX_COMPLETE = '/api/agent/owner-mailbox/complete';

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
function unavailable(): Response { return json(503, { code: 'unavailable' }); }
export type MailboxFailureStage = 'auth' | 'binding_read' | 'owner_index_read' | 'membership' | 'mailbox_submit' | 'composition';
export type MailboxFailureCode = 'session_store_unavailable' | 'store_unavailable' | 'matrix_unavailable'
  | 'mailbox_full' | 'submit_failed' | 'load_failed' | 'route_missing' | 'handle_failed'
  | Exclude<MailboxSubmitDiagnostic, 'capacity'>;
export type MailboxDiagnostic = (entry: Readonly<{ stage: MailboxFailureStage; code: MailboxFailureCode }>) => void;
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function readCommand(value: unknown): (OwnerMailboxCommand & { bindingId: string }) | null {
  if (!plain(value) || !exact(value, ['bindingId', 'operationId', 'kind', 'body'])
    || typeof value.bindingId !== 'string' || typeof value.operationId !== 'string'
    || !['controls_status', 'controls_set', 'listening_set', 'listening_grant', 'review_preview', 'review_approve'].includes(String(value.kind))) return null;
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
  /** Existing DPoP attestation, never a Matrix device-list guess. */
  lookupAgentDevice(binding: SessionBinding): Promise<Readonly<{ userId: string; deviceId: string; fingerprint: string }> | null>;
  diagnostic?: MailboxDiagnostic;
}>): Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[] }> {
  const bindings = createAgentBindingStore({ store: input.store });
  const ownerRooms = createOwnerRoomIndex(input.store);
  const submitUnavailable = (stage: MailboxFailureStage, code: MailboxFailureCode): Response => {
    try { input.diagnostic?.({ stage, code }); } catch { /* Diagnostics never affect authorization. */ }
    return json(503, { code: 'unavailable', stage, errorCode: code });
  };
  async function owner(request: Request, bindingId: string, mutate: boolean): Promise<
    Readonly<{ principal: AuthPrincipal; binding: SessionBinding; roomId: RoomId }> | Response
  > {
    let signed: Awaited<ReturnType<AuthService['requireHumanMutation']>> | Awaited<ReturnType<AuthService['authenticateRequest']>>;
    try { signed = mutate ? await input.auth.requireHumanMutation(request) : await input.auth.authenticateRequest(request); }
    catch { return mutate ? submitUnavailable('auth', 'session_store_unavailable') : unavailable(); }
    if (signed.kind === 'unavailable') return mutate ? submitUnavailable('auth', 'session_store_unavailable') : unavailable();
    if (signed.kind !== 'authorized' && signed.kind !== 'authenticated') {
      return json(signed.kind === 'signed_out' || ('code' in signed && signed.code === 'signed_out') ? 401 : 403,
        { code: 'owner_auth_required' });
    }
    const principal = signed.context.principal;
    let found: Awaited<ReturnType<typeof bindings.locateBinding>>;
    try { found = await bindings.locateBinding(bindingId as BindingId); }
    catch { return mutate ? submitUnavailable('binding_read', 'store_unavailable') : unavailable(); }
    if (found.kind === 'unavailable') return mutate ? submitUnavailable('binding_read', 'store_unavailable') : unavailable();
    if (found.kind !== 'found' || found.record.revokedGeneration !== null
      || found.record.binding.ownerId !== principal.ownerId) return json(403, { code: 'forbidden' });
    let indexed: Awaited<ReturnType<typeof ownerRooms.inspect>>;
    try { indexed = await ownerRooms.inspect(principal.ownerId, found.address.roomId); }
    catch { return mutate ? submitUnavailable('owner_index_read', 'store_unavailable') : unavailable(); }
    if (indexed.kind !== 'ok') return mutate ? submitUnavailable('owner_index_read', 'store_unavailable') : unavailable();
    if (indexed.value?.marker) return json(403, { code: 'channel_closing' });
    let membership: Awaited<ReturnType<typeof input.gateway.inspectMembership>>;
    try { membership = await input.gateway.inspectMembership({ roomId: found.address.roomId, principal, history: 'none' }); }
    catch { return mutate ? submitUnavailable('membership', 'matrix_unavailable') : unavailable(); }
    if (membership.kind === 'unavailable') return mutate ? submitUnavailable('membership', 'matrix_unavailable') : unavailable();
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
    const indexed = await ownerRooms.inspect(authorized.ownerId, authorized.roomId);
    if (indexed.kind !== 'ok') return unavailable();
    return { binding: authorized.binding, roomId: authorized.roomId, closing: indexed.value?.marker !== null && indexed.value?.marker !== undefined };
  }
  return {
    human: Object.freeze([
      { path: OWNER_REVIEW_BINDINGS, methods: ['GET'], async handle(request: Request) {
        const url = new URL(request.url);
        const roomId = url.searchParams.get('room_id');
        if (!roomId || [...url.searchParams.keys()].join(',') !== 'room_id') return json(400, { code: 'invalid_request' });
        const signed = await input.auth.authenticateRequest(request);
        if (signed.kind === 'unavailable') return unavailable();
        if (signed.kind !== 'authenticated') return json(401, { code: 'owner_auth_required' });
        const principal = signed.context.principal;
        const membership = await input.gateway.inspectMembership({ roomId: roomId as RoomId, principal, history: 'none' });
        if (membership.kind === 'unavailable') return unavailable();
        if (membership.kind !== 'joined') return json(403, { code: 'forbidden' });
        const indexed = await ownerRooms.inspect(principal.ownerId, roomId as RoomId);
        if (indexed.kind !== 'ok') return unavailable();
        if (indexed.value?.marker) return json(403, { code: 'channel_closing' });
        const active = [];
        for (const candidate of indexed.value?.bindings ?? []) {
          const found = await bindings.locateBinding(candidate.bindingId as BindingId);
          if (found.kind === 'unavailable') return unavailable();
          if (found.kind === 'found' && found.record.revokedGeneration === null
            && found.address.ownerId === principal.ownerId && found.address.roomId === roomId
            && found.record.binding.generation === candidate.generation) {
            const device = await input.lookupAgentDevice(found.record.binding);
            active.push({ bindingId: found.record.binding.bindingId, generation: candidate.generation,
              agentParticipantId: found.record.binding.agentParticipantId, device });
          }
        }
        return json(200, { v: 1, roomId, bindings: active });
      } },
      { path: OWNER_MAILBOX_SUBMIT, methods: ['POST'], async handle(request: Request) {
        let body: ReturnType<typeof readCommand> = null;
        try { body = readCommand(await request.json()); } catch { /* malformed */ }
        if (!body) return json(400, { code: 'invalid_request' });
        const authority = await owner(request, body.bindingId, true);
        if (authority instanceof Response) return authority;
        let mailbox: ReturnType<typeof createOwnerMailbox>;
        let submitCause: MailboxSubmitDiagnostic | null = null;
        try { mailbox = createOwnerMailbox({ store: input.store, binding: authority.binding, roomId: authority.roomId,
          clock: input.clock, authoritySecret: input.authoritySecret, submitDiagnostic: cause => { submitCause = cause; } }); }
        catch { return submitUnavailable('composition', 'load_failed'); }
        let result: Awaited<ReturnType<typeof mailbox.submit>>;
        try { result = await mailbox.submit({ operationId: body.operationId, kind: body.kind as OwnerCommandKind,
          body: body.body }, authority.principal); }
        catch { return submitUnavailable('mailbox_submit', 'submit_failed'); }
        return result.kind === 'ok' ? json(200, { v: 1, operationId: result.value.operationId, outcome: result.value.outcome })
          : result.kind === 'conflict' ? json(409, { code: 'operation_conflict' })
            : result.kind === 'capacity' ? submitUnavailable('mailbox_submit', 'mailbox_full')
            : submitUnavailable('mailbox_submit', submitCause === 'capacity' || submitCause === null ? 'store_unavailable' : submitCause);
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
      { path: OWNER_REVIEW_STATUS, methods: ['GET'], async handle(request: Request) {
        const url = new URL(request.url);
        const bindingId = url.searchParams.get('binding_id');
        if (!bindingId || [...url.searchParams.keys()].join(',') !== 'binding_id') return json(400, { code: 'invalid_request' });
        const authority = await owner(request, bindingId, false);
        if (authority instanceof Response) return authority;
        const mailbox = createOwnerMailbox({ store: input.store, binding: authority.binding, roomId: authority.roomId,
          clock: input.clock, authoritySecret: input.authoritySecret });
        const preview = await mailbox.lastReviewPreview();
        if (preview.kind !== 'ok') return unavailable();
        return json(200, { v: 1, bindingId, generation: authority.binding.generation,
          status: 'waiting_for_agent', preview: preview.value });
      } },
    ] satisfies RouteRegistration[]),
    agent: Object.freeze([
      { path: OWNER_MAILBOX_POLL, methods: ['GET'], async handle(request: Request) {
        const identity = await agent(request, 'receive_released');
        if (identity instanceof Response) return identity;
        const result = await createOwnerMailbox({ store: input.store, ...identity, clock: input.clock, authoritySecret: input.authoritySecret }).pending();
        return result.kind === 'ok' ? json(200, { v: 1, bindingId: identity.binding.bindingId,
          generation: identity.binding.generation, closing: identity.closing,
          entries: result.value.filter(entry => !identity.closing || entry.kind === 'channel_stop').map(entry => ({
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
        const mailbox = createOwnerMailbox({ store: input.store, binding: identity.binding, roomId: identity.roomId,
          clock: input.clock, authoritySecret: input.authoritySecret });
        if (identity.closing) {
          const queued = await mailbox.result(body.operationId);
          if (queued.kind !== 'ok') return unavailable();
          if (queued.value?.kind !== 'channel_stop') return json(403, { code: 'channel_closing' });
        }
        const result = await mailbox.complete(body.operationId, body.outcome);
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
  return { human: [absent(OWNER_REVIEW_BINDINGS, 'GET'), absent(OWNER_MAILBOX_SUBMIT, 'POST'), absent(OWNER_MAILBOX_RESULT, 'GET'),
    absent(OWNER_REVIEW_STATUS, 'GET')],
    agent: [absent(OWNER_MAILBOX_POLL, 'GET'), absent(OWNER_MAILBOX_COMPLETE, 'POST')] };
}

/** Generated gateway metadata is static; live stores and auth load only per request. */
export function createLazyOwnerMailboxRoutes(load: () => ReturnType<typeof createOwnerMailboxRoutes>,
  diagnostic?: MailboxDiagnostic): ReturnType<typeof createOwnerMailboxRoutes> {
  const defaults = unavailableOwnerMailboxRoutes();
  const bind = (routes: readonly RouteRegistration[], domain: 'human' | 'agent'): readonly RouteRegistration[] =>
    routes.map((route, index) => ({ path: route.path, methods: route.methods,
      handle: async (request: Request) => {
        let selected: RouteRegistration | undefined;
        try { selected = load()[domain][index]; }
        catch {
          try { diagnostic?.({ stage: 'composition', code: 'load_failed' }); } catch { /* diagnostic only */ }
          return json(503, { code: 'unavailable', stage: 'composition', errorCode: 'load_failed' });
        }
        if (!selected) {
          try { diagnostic?.({ stage: 'composition', code: 'route_missing' }); } catch { /* diagnostic only */ }
          return json(503, { code: 'unavailable', stage: 'composition', errorCode: 'route_missing' });
        }
        try { return await selected.handle(request); }
        catch {
          try { diagnostic?.({ stage: 'composition', code: 'handle_failed' }); } catch { /* diagnostic only */ }
          return json(503, { code: 'unavailable', stage: 'composition', errorCode: 'handle_failed' });
        }
      } }));
  return { human: bind(defaults.human, 'human'), agent: bind(defaults.agent, 'agent') };
}
