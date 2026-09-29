// Hosted side of agent-operated link bootstrap (KHA-114), the candidate trust
// path proved by KHA-144:
//
// 1. `GET  /api/agent/bootstrap/descriptor`  public; names the invite and methods only.
// 2. `GET  /api/human/agent-bootstrap/authorize`  the owner's own browser gets a consent
//    page. The session cookie is the owner evidence; nothing is issued yet.
//    `POST` of that page (Origin, fetch metadata and the session's CSRF token) sends a
//    one-time code to a loopback redirect.
// 3. `POST /api/agent/bootstrap/token`  code + PKCE + key proof → 60 s bootstrap grant.
// 4. `POST /api/agent/bootstrap/redeem`  grant + key proof → session binding and a
//    sender-constrained adapter capability for that binding and generation.
//
// A link grants nothing. The owner comes only from the authenticated session. The
// grant is redeemed once and admits this device for this session. The capability
// carries only `publish_own`, `receive_released` and `ack_delivery`: it cannot
// approve, release or set policy, or act as the human. Revoking the binding
// invalidates it. Every response is a finite code.

import { createHash } from 'node:crypto';
import {
  type AdmissionPort, type AdmissionRejection, type AuthPrincipal, type BindingId, type CallOptions, type ControlStore, type JsonValue,
  type OperationResult,
  type OwnerId, type ParticipantId, type RoomId, type SessionBinding, type TrustedClock, isSameOriginReturnPath, sameJsonValue,
} from '@khala/contracts/messaging/index';
import type { Authentication } from '../auth/index';
import { LOGIN_PATH } from '../auth/callback';
import { checkMutationOrigin, csrfMatches, safeEqual } from '../auth/csrf';
import { type Random, guardStore, randomToken, settleWrite } from '../auth/store';
import type { RouteRegistration } from '../runtime/handler';
import type { PairingGrantPort } from '../pairing/store';
import { type ProofCheck, checkProof, proofKeyThumbprint } from './proof';
import { type BindingRecord, createAgentBindingStore } from './store';
import { createOwnerRoomIndex } from './owner-room-index';

export const DESCRIPTOR_PATH = '/api/agent/bootstrap/descriptor';
export const AUTHORIZE_PATH = '/api/human/agent-bootstrap/authorize';
export const TOKEN_PATH = '/api/agent/bootstrap/token';
export const REDEEM_PATH = '/api/agent/bootstrap/redeem';
export const REFRESH_CHALLENGE_PATH = '/api/agent/bootstrap/refresh/challenge';
export const REFRESH_PATH = '/api/agent/bootstrap/refresh';
export const OWNERSHIP_METHOD = 'loopback-browser-v1';

/**
 * A pairing grant names a channel, not an invite. Its admission `inviteRef` is this
 * prefix plus the room id, so an admission port can tell the two apart.
 */
export const PAIRING_INVITE_PREFIX = 'pairing:';
export function pairingInviteRef(roomId: RoomId): string {
  return `${PAIRING_INVITE_PREFIX}${roomId}`;
}

/** Lifetime of a one-time code and of a bootstrap grant (KHA-144: 60 s each). */
export const CODE_TTL_MS = 60_000;
export const GRANT_TTL_MS = 60_000;
/** Lifetime of an adapter capability. Revocation ends it sooner. */
export const CAPABILITY_TTL_MS = 3_600_000;

/** The model-facing adapter's whole scope (docs/research/04-identity-trust.md). No approve, release or policy. */
export const ADAPTER_CAPABILITIES = ['publish_own', 'receive_released', 'ack_delivery'] as const;
export type AdapterAction = (typeof ADAPTER_CAPABILITIES)[number];
/** Replay window for proof `jti`s: longer than a proof's accepted age plus skew. */
const PROOF_REPLAY_TTL_MS = 120_000;

/** The G-ADMISSION decision: whether this signed-in human may bind an agent through this invite. */
export type AdmissionPolicy = (input: Readonly<{ principal: AuthPrincipal; inviteRef: string; session: SessionRef }>) => Promise<'allow' | 'deny'>;

/**
 * Inspects and then admits the owner's exact verified agent participant into the
 * invite's room (KHA-113 / G-SUBSTRATE). Inspection is side-effect free. Commit
 * atomically refuses if the room or participant no longer matches the expectation.
 */
export interface AgentAdmissionPort {
  inspect(input: Readonly<{ ownerId: OwnerId; principal?: AuthPrincipal | null; inviteRef: string; session: SessionRef; inviteEvidence?: InviteEvidence | null }>): Promise<
    OperationResult<Readonly<{ agentParticipantId: ParticipantId; roomId: RoomId }>, AdmissionRejection>
  >;
  admit(input: Readonly<{
    ownerId: OwnerId;
    inviteRef: string;
    deviceId: string;
    session: SessionRef;
    expectedAgentParticipantId: ParticipantId;
    expectedRoomId: RoomId;
    operationId: string;
    principal?: AuthPrincipal | null;
    inviteEvidence?: InviteEvidence | null;
  }>): Promise<
    OperationResult<Readonly<{ agentParticipantId: ParticipantId; roomId: RoomId }>, AdmissionRejection>
  >;
}

export type AgentMatrixSession = Readonly<{
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  roomId: string;
  ownerUserId: string;
  ownerParticipantId: string;
}>;

/** Mints only the already-admitted binding's Matrix device session. */
export interface AgentDeviceSessionPort {
  issue(binding: SessionBinding, roomId: RoomId): Promise<AgentMatrixSession | null>;
}

/** The exact immutable link policy and authoritative store revision approved in the owner browser. */
export type InviteEvidence = Readonly<{
  roomId: RoomId;
  revision: string;
  policyDigest: string;
}>;

/** Result of checking an adapter request against its capability. */
export type AdapterAuthorization =
  | Readonly<{ kind: 'authorized'; action: AdapterAction; ownerId: OwnerId; roomId: RoomId; binding: SessionBinding }>
  | Readonly<{ kind: 'refused'; status: 401 | 403; code: AdapterRefusal }>
  | Readonly<{ kind: 'unavailable' }>;

export type AdapterRefusal =
  | 'capability_required' | 'invalid_capability' | 'capability_not_granted' | 'binding_revoked' | 'binding_superseded'
  | 'proof_required' | 'invalid_proof' | 'proof_key_mismatch' | 'proof_target_mismatch' | 'proof_token_mismatch' | 'proof_replayed';

/**
 * A binding as the revocation service (KHA-128) and trust policy see it. `generation` is the
 * control plane's authoritative generation: the bound generation while active, and the revoked
 * generation once revoked, which never advances. The messaging device key is not held here; the
 * composition root resolves it from the substrate.
 */
export type BindingLookupResult =
  | Readonly<{ kind: 'found'; ownerId: OwnerId; generation: number; deviceId: SessionBinding['deviceId']; status: 'active' | 'revoked' }>
  | Readonly<{ kind: 'absent' | 'unavailable' }>;

/**
 * The adapter capability's side of KHA-128. `revokeAdapterCapability` has the shape of
 * `RevocationControlPort.revokeAdapterCapability` in `@khala/messaging/revocation`, so a
 * composition root can pass it straight through.
 */
export interface AdapterCapabilities {
  /** Checks an adapter request: `Authorization: DPoP <capability>` plus a proof for this exact request. */
  authorize(request: Request, action: string): Promise<AdapterAuthorization>;
  /** DPoP-authenticated old capability, usable only by a dedicated revoked-binding cleanup route. */
  authorizeRevocationCleanup(request: Request): Promise<
    Readonly<{ kind: 'authorized'; ownerId: OwnerId; roomId: RoomId; binding: SessionBinding; revokedGeneration: number; capabilityDigest: string }>
    | Readonly<{ kind: 'refused'; status: 401 | 403; code: AdapterRefusal }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  /** Reads one binding by ID. A replaced binding is `absent`: it holds no authority any more. */
  lookupBinding(bindingId: BindingId | string): Promise<BindingLookupResult>;
  /**
   * The binding side of `RevocationControlPort.disable`: moves an active binding at `expectedGeneration`
   * to `revokedGeneration` and drops its capability. Idempotent: a binding already revoked at
   * `revokedGeneration` answers `applied`. Any other binding state is `stale`.
   */
  disableBinding(
    input: Readonly<{ operationId: string; bindingId: BindingId; expectedGeneration: number; revokedGeneration: number }>,
    options?: CallOptions,
  ): Promise<Readonly<{ kind: 'applied' | 'stale' | 'outcome_unknown' | 'unavailable' }>>;
  /** After `applied`, no capability issued for `bindingId` is accepted, whatever its generation. Idempotent. */
  revokeAdapterCapability(
    input: Readonly<{ operationId: string; bindingId: BindingId; revokedGeneration: number }>,
    options?: CallOptions,
  ): Promise<Readonly<{ kind: 'applied' | 'outcome_unknown' | 'unavailable' }>>;
  /**
   * Re-issues the adapter capability for a binding that was already admitted, bound to the
   * key that admitted it. It never creates, replaces or admits a binding: the binding must
   * exist and match the owner, device and generation exactly, and must not be revoked.
   */
  resumeAdapterCapability(input: Readonly<{
    bindingId: string; ownerId: OwnerId; deviceId: string; generation: number; jkt: string;
    planned?: Readonly<{ token: string; expiresAt: number; operationId: string; previousCapability: string }>;
  }>): Promise<AdapterResume>;
}

export type AdapterResume =
  | Readonly<{
    kind: 'resumed'; binding: SessionBinding;
    capability: Readonly<{ token: string; scope: readonly AdapterAction[]; expiresAt: number }>;
  }>
  | Readonly<{ kind: 'refused'; code: 'binding_revoked' | 'binding_conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

export type AgentBootstrapDeps = Readonly<{
  /** Exact public origin, e.g. `https://khala.aiur.team`. */
  origin: string;
  allowInsecureLoopback?: boolean;
  store: ControlStore;
  clock: TrustedClock;
  random: Random;
  /** KHA-110 `AuthService.authenticateRequest`. */
  authenticate(request: Request): Promise<Authentication>;
  /** KHA-132 route codec: the invite a share link names, or `null`. */
  inviteFromLink(url: URL): string | null;
  /** Request-scoped KHA-105 admission port for the signed-in owner. */
  admissionFor(request: Request): Pick<AdmissionPort, 'inspect'>;
  /** Persist the signed-in owner's eligible per-link scope in the one-use grant. */
  inviteEvidenceFor?: (principal: AuthPrincipal, inviteRef: string) => Promise<InviteEvidence | null>;
  /** No default: the deployment must decide G-ADMISSION explicitly. */
  admissionPolicy: AdmissionPolicy;
  agents: AgentAdmissionPort;
  /** Production adapter; no control-plane persistence of Matrix access tokens. */
  agentDeviceSession?: AgentDeviceSessionPort;
  /** The current Matrix owner membership, required on every credential renewal. */
  inspectOwnerMembership?: (ownerId: OwnerId, roomId: RoomId) => Promise<Readonly<{ kind: 'joined' | 'absent' | 'unavailable' }>>;
  /** Pairing-code grants (`pairing-code-v1`), redeemed at the same route as bootstrap grants. Absent disables them. */
  pairingGrants?: PairingGrantPort;
  /** Serves the code-only descriptor from the shared descriptor path; `null` means "not a pairing request". */
  pairingDescriptor?: (request: Request) => Response | null;
  /** Roll-forward gate for legacy singleton records; marker-aware reads are always enabled. */
  legacyMigrationWritesEnabled: boolean;
}>;

export type SessionRef = Readonly<{ harness: string; sessionId: string; generation: number }>;

type CodeRecord = {
  ownerId: string; invite: string; harness: string; sessionId: string; generation: number;
  deviceId: string; jkt: string; challenge: string; redirectUri: string; used: boolean;
  inviteEvidence?: InviteEvidence | null;
  principal?: AuthPrincipal | null;
};
/**
 * `redemption` is set by the one operation that claimed the grant. `admitted` records
 * the admission so a retry of that operation never admits again, and `issued` is set
 * before a capability is minted, so a grant yields at most one.
 */
type Redemption = { operationId: string; admitted: { agentParticipantId: string; roomId: string } | null; issued: boolean };
type GrantRecord = {
  ownerId: string; invite: string; harness: string; sessionId: string; generation: number;
  deviceId: string; jkt: string; redemption: Redemption | null;
  inviteEvidence?: InviteEvidence | null;
  principal?: AuthPrincipal | null;
};
type CapabilityRecord = {
  ownerId: string; roomId: string; bindingId: string; generation: number; jkt: string; scope: string[];
};
type RefreshSlot = {
  v: 1; bindingId: string; ownerId: string; deviceId: string; generation: number;
  jkt: string; operationId: string; nonce: string; token: string; expiresAt: number; previousCapability: string;
};

const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[A-Za-z0-9._~-]{16,128}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TEXT_BYTES = 512;

export type AgentBootstrapHandlers = Readonly<{
  human: readonly RouteRegistration[];
  agent: readonly RouteRegistration[];
  /** For the adapter routes (KHA-133) and the revocation service's control port (KHA-136). */
  capabilities: AdapterCapabilities;
}>;

/** Route registrations for the human (`/api/human/`) and agent (`/api/agent/`) domains. */
export function createAgentBootstrapHandlers(deps: AgentBootstrapDeps): AgentBootstrapHandlers {
  const origin = new URL(deps.origin);
  const localOrigin = deps.allowInsecureLoopback === true && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || localOrigin) || origin.origin !== deps.origin) throw new Error('bootstrap origin must be an exact https origin');
  if (typeof deps.admissionPolicy !== 'function') throw new Error('an explicit admission policy is required (G-ADMISSION)');
  if (typeof deps.legacyMigrationWritesEnabled !== 'boolean') throw new Error('legacy migration write activation must be explicit');
  const store = guardStore(deps.store);
  const bindings = createAgentBindingStore({ store: deps.store, legacyMigrationWritesEnabled: deps.legacyMigrationWritesEnabled });
  const ownerRooms = createOwnerRoomIndex(store);
  const tokenUrl = `${deps.origin}${TOKEN_PATH}`;
  const redeemUrl = `${deps.origin}${REDEEM_PATH}`;
  const refreshChallengeUrl = `${deps.origin}${REFRESH_CHALLENGE_PATH}`;
  const refreshUrl = `${deps.origin}${REFRESH_PATH}`;

  async function refreshBinding(bindingId: string, jkt: string) {
    if (!OPERATION_ID.test(bindingId) || !B64URL_43.test(jkt) || !deps.inspectOwnerMembership) return null;
    const found = await bindings.locateBinding(bindingId);
    if (found.kind !== 'found' || found.record.revokedGeneration !== null) return null;
    const { binding } = found.record;
    const { address } = found;
    if (await pinProofKey(binding, jkt) !== 'matched') return null;
    const index = await ownerRooms.inspect(binding.ownerId, address.roomId);
    if (index.kind !== 'ok' || index.value?.marker || !index.value?.bindings.some(item =>
      item.bindingId === bindingId && item.generation === binding.generation)) return null;
    const membership = await safeCall(() => deps.inspectOwnerMembership!(binding.ownerId, address.roomId));
    return membership?.kind === 'joined' ? { binding, address, capability: found.record.capability } : null;
  }

  async function refreshChallenge(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].join(',') !== 'binding_id') return json(400, { code: 'invalid_request' });
    const bindingId = url.searchParams.get('binding_id');
    const jkt = proofKeyThumbprint(request.headers.get('dpop'));
    if (!bindingId || !jkt) return json(401, { code: 'invalid_proof' });
    const current = await refreshBinding(bindingId, jkt);
    if (!current) return json(403, { code: 'binding_revoked' });
    const proof = await verifyFreshProof(request, { method: 'GET', url: refreshChallengeUrl, jkt });
    if (proof) return proof;
    const nonce = randomToken(deps.random, 32);
    const written = await settleWrite<JsonValue>(store, {
      key: key('refresh-challenge', nonce), expectedRevision: null,
      operationId: `refresh-challenge.${nonce}`,
      next: { value: { v: 1, bindingId, generation: current.binding.generation, jkt },
        expiresAt: new Date(deps.clock() + CODE_TTL_MS).toISOString() },
    });
    return written.kind === 'applied' ? json(200, { v: 1, nonce, expires_at: deps.clock() + CODE_TTL_MS })
      : json(503, { code: 'unavailable' });
  }

  async function refresh(request: Request): Promise<Response> {
    if (request.headers.get('origin') !== deps.origin
      || (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return json(403, { code: 'invalid_request' });
    const raw = await request.text().catch(() => '');
    if (!raw || Buffer.byteLength(raw) > 2048) return json(400, { code: 'invalid_request' });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid');
      body = parsed as Record<string, unknown>;
    } catch { return json(400, { code: 'invalid_request' }); }
    if (Object.keys(body).sort().join(',') !== 'binding_id,device_id,generation,nonce,operation_id,owner_id'
      || typeof body.binding_id !== 'string' || !OPERATION_ID.test(body.binding_id)
      || typeof body.operation_id !== 'string' || !OPERATION_ID.test(body.operation_id)
      || typeof body.nonce !== 'string' || !TOKEN.test(body.nonce)
      || typeof body.owner_id !== 'string' || typeof body.device_id !== 'string'
      || !Number.isSafeInteger(body.generation) || (body.generation as number) < 0)
      return json(400, { code: 'invalid_request' });
    const jkt = proofKeyThumbprint(request.headers.get('dpop'));
    if (!jkt) return json(401, { code: 'invalid_proof' });
    const current = await refreshBinding(body.binding_id, jkt);
    if (!current || current.binding.ownerId !== body.owner_id || current.binding.deviceId !== body.device_id
      || current.binding.generation !== body.generation) return json(403, { code: 'binding_revoked' });
    const proof = await verifyFreshProof(request, { method: 'POST', url: refreshUrl, jkt,
      nonce: body.nonce, bodyHash: createHash('sha256').update(raw).digest('base64url') });
    if (proof) return proof;
    const slotKey = key('refresh-slot', body.binding_id);
    let plan: RefreshSlot | null = null;
    const seen = await store.read<JsonValue>(slotKey);
    if (seen.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (seen.kind === 'record') {
      const value = seen.record.value;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return json(503, { code: 'unavailable' });
      const candidate = value as unknown as RefreshSlot;
      if (candidate.v !== 1 || candidate.bindingId !== body.binding_id || candidate.operationId !== body.operation_id
        || candidate.nonce !== body.nonce || candidate.ownerId !== body.owner_id || candidate.deviceId !== body.device_id
        || candidate.generation !== body.generation || candidate.jkt !== jkt || !TOKEN.test(candidate.token)
        || !Number.isSafeInteger(candidate.expiresAt) || typeof candidate.previousCapability !== 'string'
        || !B64URL_43.test(candidate.previousCapability)) return json(409, { code: 'operation_conflict' });
      plan = candidate;
    } else {
      const challenge = await store.read<JsonValue>(key('refresh-challenge', body.nonce));
      if (challenge.kind !== 'record' || !sameJsonValue(challenge.record.value,
        { v: 1, bindingId: body.binding_id, generation: body.generation, jkt }))
        return json(403, { code: 'invalid_challenge' });
      if (!current.capability || !B64URL_43.test(current.capability)) return json(403, { code: 'binding_conflict' });
      const created: RefreshSlot = { v: 1, bindingId: body.binding_id, ownerId: body.owner_id,
        deviceId: body.device_id, generation: body.generation as number, jkt, operationId: body.operation_id,
        nonce: body.nonce, token: randomToken(deps.random, 32), expiresAt: deps.clock() + CAPABILITY_TTL_MS,
        previousCapability: current.capability };
      const written = await settleWrite<JsonValue>(store, { key: slotKey, expectedRevision: null,
        operationId: `refresh-slot.${body.binding_id}.${body.operation_id}`,
        next: { value: created as unknown as JsonValue, expiresAt: new Date(created.expiresAt).toISOString() } });
      if (written.kind === 'unavailable') return json(503, { code: 'unavailable' });
      if (written.kind === 'conflict') return json(409, { code: 'operation_conflict' });
      plan = created;
    }
    const resumed = await capabilities.resumeAdapterCapability({ bindingId: body.binding_id,
      ownerId: current.binding.ownerId, deviceId: current.binding.deviceId, generation: current.binding.generation,
      jkt, planned: { token: plan.token, expiresAt: plan.expiresAt, operationId: plan.operationId,
        previousCapability: plan.previousCapability } });
    return resumed.kind === 'resumed' ? json(200, { v: 1, binding: resumed.binding,
      adapter_capability: { token: resumed.capability.token, token_type: 'DPoP', scope: [...ADAPTER_CAPABILITIES],
        binding_id: resumed.binding.bindingId, generation: resumed.binding.generation,
        expires_at: resumed.capability.expiresAt } })
      : json(resumed.kind === 'refused' ? 403 : 503, { code: resumed.kind === 'refused' ? resumed.code : 'unavailable' });
  }

  async function describe(request: Request): Promise<Response> {
    const paired = deps.pairingDescriptor?.(request) ?? null;
    if (paired !== null) return paired;
    const raw = new URL(request.url).searchParams.get('link');
    let link: URL | null = null;
    try {
      link = raw === null ? null : new URL(raw);
    } catch {
      link = null;
    }
    if (!link || link.origin !== deps.origin || link.username !== '' || link.password !== '') return json(404, { code: 'unknown_link' });
    const invite = safeInvoke(() => deps.inviteFromLink(link!));
    if (!isText(invite)) return json(404, { code: 'unknown_link' });
    // Existence is not revealed here: an unknown invite fails at authorize, for a signed-in owner.
    return json(200, {
      v: 1,
      invite,
      methods: [OWNERSHIP_METHOD],
      authorize: `${deps.origin}${AUTHORIZE_PATH}`,
      token: tokenUrl,
      redeem: redeemUrl,
    });
  }

  /** Consent page. Read-only: it checks the owner, invite and policy, and issues nothing. */
  async function consent(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const params = readAuthorizeParams(url.searchParams);
    // Without a valid loopback redirect there is nowhere safe to send an answer.
    if (!params) return json(400, { code: 'invalid_request' });
    const auth = await deps.authenticate(request).catch(() => ({ kind: 'unavailable' }) as const);
    if (auth.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (auth.kind === 'signed_out') return signIn(params);
    const refusal = await admissible(request, auth.context.principal, params);
    if (refusal) return refusal;
    return consentPage(params, auth.context.csrfToken);
  }

  /**
   * The owner's confirmation. A state-changing POST under #68's checks: exact Origin,
   * same-origin fetch metadata, then the session's CSRF token, carried as a form field.
   */
  async function authorize(request: Request): Promise<Response> {
    if (checkMutationOrigin(request, deps.origin) !== 'ok') return json(403, { code: 'forbidden_origin' });
    const form = await readForm(request);
    const params = form && readAuthorizeParams(form);
    if (!form || !params) return json(400, { code: 'invalid_request' });
    const auth = await deps.authenticate(request).catch(() => ({ kind: 'unavailable' }) as const);
    if (auth.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (auth.kind === 'signed_out') return signIn(params);
    const presented = form.getAll('csrf');
    if (presented.length !== 1 || !csrfMatches(presented[0]!, auth.context.csrfToken)) return json(403, { code: 'csrf_mismatch' });
    const decision = form.getAll('decision');
    if (decision.length !== 1 || (decision[0] !== 'allow' && decision[0] !== 'deny')) return json(400, { code: 'invalid_request' });
    if (decision[0] === 'deny') return loopback(params.redirectUri, { error: 'access_denied', state: params.state });
    const { principal } = auth.context;
    const refusal = await admissible(request, principal, params);
    if (refusal) return refusal;
    const inviteEvidence = deps.inviteEvidenceFor
      ? await safeCall(() => deps.inviteEvidenceFor!(principal, params.invite))
      : null;
    if (deps.inviteEvidenceFor && inviteEvidence === null) return json(503, { code: 'unavailable' });

    const code = randomToken(deps.random, 32);
    const now = deps.clock();
    const value: CodeRecord = {
      ownerId: principal.ownerId, invite: params.invite, ...params.session, deviceId: params.deviceId,
      jkt: params.jkt, challenge: params.challenge, redirectUri: params.redirectUri, used: false, inviteEvidence, principal,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: key('code', code), expectedRevision: null, operationId: `code-${randomToken(deps.random, 16)}`,
      next: { value, expiresAt: new Date(now + CODE_TTL_MS).toISOString() },
    });
    if (written.kind !== 'applied') return json(503, { code: 'unavailable' });
    return loopback(params.redirectUri, { code, state: params.state });
  }

  /** The invite and G-ADMISSION checks both authorize steps repeat. Returns a response only on refusal. */
  async function admissible(request: Request, principal: AuthPrincipal, params: AuthorizeParams): Promise<Response | null> {
    const deny = (error: string) => loopback(params.redirectUri, { error, state: params.state });
    const invite = await safeCall(() => deps.admissionFor(request).inspect(params.invite));
    if (invite === null || invite === 'unavailable') return json(503, { code: 'unavailable' });
    if (invite === 'auth_required') return signIn(params);
    if (invite === 'expired' || invite === 'revoked') return deny('invite_unavailable');
    if (invite !== 'eligible' && invite !== 'already_joined') return deny('access_denied');
    const decision = await safeCall(() => deps.admissionPolicy({ principal, inviteRef: params.invite, session: params.session }));
    if (decision === null) return json(503, { code: 'unavailable' });
    if (decision !== 'allow') return deny('access_denied');
    return null;
  }

  async function token(request: Request): Promise<Response> {
    const body = await readBody(request);
    const session = body && readSession(body);
    if (!body || !session || typeof body.code !== 'string' || !TOKEN.test(body.code) || typeof body.code_verifier !== 'string'
      || !VERIFIER.test(body.code_verifier) || typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id)
      || typeof body.redirect_uri !== 'string') {
      return json(400, { code: 'invalid_request' });
    }
    const codeKey = key('code', body.code);
    const read = await store.read<CodeRecord>(codeKey);
    if (read.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (read.kind === 'absent' || read.record.value.used) return json(400, { code: 'invalid_grant' });
    const pending = read.record.value;
    // Consume before checking anything else, so a wrong verifier or key burns the code.
    // The revision check makes this the only exchange of the code that can win.
    const consumed = await settleWrite<JsonValue>(store, {
      key: codeKey, expectedRevision: read.record.revision, operationId: `consume-${randomToken(deps.random, 16)}`,
      next: { value: { ...pending, used: true }, expiresAt: read.record.expiresAt },
    });
    if (consumed.kind === 'conflict') return json(400, { code: 'invalid_grant' });
    if (consumed.kind !== 'applied') return json(503, { code: 'unavailable' });
    const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
    // RFC 6749 §4.1.3: the redirect URI must be the one the code was issued to.
    if (!safeEqual(challenge, pending.challenge) || !sameSession(pending, session) || pending.deviceId !== body.device_id
      || body.redirect_uri !== pending.redirectUri) {
      return json(400, { code: 'invalid_grant' });
    }
    const proof = await verifyFreshProof(request, { method: 'POST', url: tokenUrl, jkt: pending.jkt });
    if (proof) return proof;

    const grant = randomToken(deps.random, 32);
    const expiresAt = deps.clock() + GRANT_TTL_MS;
    const value: GrantRecord = {
      ownerId: pending.ownerId, invite: pending.invite, harness: pending.harness, sessionId: pending.sessionId,
      generation: pending.generation, deviceId: pending.deviceId, jkt: pending.jkt, redemption: null,
      inviteEvidence: pending.inviteEvidence ?? null,
      principal: pending.principal ?? null,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: key('grant', grant), expectedRevision: null, operationId: `grant-${randomToken(deps.random, 16)}`,
      next: { value, expiresAt: new Date(expiresAt).toISOString() },
    });
    if (written.kind !== 'applied') return json(503, { code: 'unavailable' });
    return json(200, { grant, expires_at: expiresAt });
  }

  async function redeem(request: Request): Promise<Response> {
    const grant = bearer(request) ?? channelGrantBearer(request);
    const body = await readBody(request);
    const session = body && readSession(body);
    if (grant === null) return json(401, { code: 'invalid_grant' });
    if (!body || !session || typeof body.operation_id !== 'string' || !OPERATION_ID.test(body.operation_id)
      || typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id)) {
      return json(400, { code: 'invalid_request' });
    }
    const operationId = body.operation_id;
    const grantKey = key('grant', grant);
    const read = await store.read<GrantRecord>(grantKey);
    if (read.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (read.kind === 'absent') {
      return deps.pairingGrants === undefined
        ? json(401, { code: 'invalid_grant' })
        : redeemPairing(request, deps.pairingGrants, { grant, operationId, session, deviceId: body.device_id });
    }
    const held = read.record.value;
    const proof = await verifyFreshProof(request, { method: 'POST', url: redeemUrl, jkt: held.jkt, accessToken: grant });
    if (proof) return proof;
    if (!sameSession(held, session) || held.deviceId !== body.device_id) return json(401, { code: 'invalid_grant' });

    // The first operation claims the grant. Only that operation may continue, and only
    // until it has been issued a capability: after that the grant is spent.
    let revision = read.record.revision;
    const tracker: { redemption: Redemption | null } = { redemption: held.redemption };
    const saveRedemption = async (next: Redemption) => {
      const written = await settleWrite<JsonValue>(store, {
        key: grantKey, expectedRevision: revision, operationId: `redeem-${randomToken(deps.random, 16)}`,
        next: { value: { ...held, redemption: next }, expiresAt: read.record.expiresAt },
      });
      if (written.kind === 'applied') {
        revision = written.record.revision;
        tracker.redemption = next;
      }
      return written.kind;
    };
    if (tracker.redemption === null) {
      const claimed = await saveRedemption({ operationId, admitted: null, issued: false });
      if (claimed === 'conflict') return json(401, { code: 'grant_replayed' });
      if (claimed !== 'applied') return json(503, { code: 'unavailable' });
    } else if (tracker.redemption.operationId !== operationId || tracker.redemption.issued) {
      return json(401, { code: 'grant_replayed' });
    }
    return finishRedeem(held, tracker, saveRedemption);
  }

  /**
   * A pairing grant lives in the pairing store, which spends it once per operation and
   * returns the same authorization to a retry of that operation. The proof key is read
   * from the proof itself and verified, then the store refuses any grant not bound to it.
   */
  async function redeemPairing(
    request: Request, grants: PairingGrantPort,
    presented: Readonly<{ grant: string; operationId: string; session: SessionRef; deviceId: string }>,
  ): Promise<Response> {
    const dpop = request.headers.get('dpop');
    const jkt = proofKeyThumbprint(dpop);
    if (jkt === null) return json(401, { code: 'invalid_grant' });
    const proof = await verifyFreshProof(request, { method: 'POST', url: redeemUrl, jkt, accessToken: presented.grant });
    if (proof) return proof;
    const redeemed = await safeCall(() => grants.redeem({
      grant: presented.grant, operationId: presented.operationId, jkt,
      session: presented.session, deviceId: presented.deviceId,
    }));
    if (redeemed === null || redeemed.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (redeemed.kind === 'replayed') return json(401, { code: 'grant_replayed' });
    if (redeemed.kind !== 'redeemed') return json(401, { code: 'invalid_grant' });
    const { authorization } = redeemed;
    if (authorization.origin !== deps.origin || authorization.jkt !== jkt) return json(401, { code: 'invalid_grant' });
    const held: GrantRecord = {
      ownerId: authorization.ownerId,
      invite: pairingInviteRef(authorization.channelId),
      harness: authorization.harness,
      sessionId: authorization.sessionId,
      generation: authorization.generation,
      deviceId: authorization.deviceId,
      jkt,
      redemption: null,
    };
    // The store already made the spend durable; admission and binding converge on stable
    // operation ids, so a retry resumes here without a second spend.
    const tracker: { redemption: Redemption | null } = { redemption: { operationId: presented.operationId, admitted: null, issued: false } };
    const saveRedemption = async (next: Redemption) => {
      if (next.issued) {
        // The store spends the issuance too, so a later retry cannot mint a second capability.
        const marked = await safeCall(() => grants.markIssued({ grant: presented.grant, operationId: presented.operationId }));
        if (marked === 'replayed') return 'conflict';
        if (marked !== 'applied') return 'unavailable';
      }
      tracker.redemption = next;
      return 'applied';
    };
    return finishRedeem(held, tracker, saveRedemption);
  }

  async function finishRedeem(
    held: GrantRecord,
    tracker: { redemption: Redemption | null },
    saveRedemption: (next: Redemption) => Promise<string>,
  ): Promise<Response> {
    const ownerId = held.ownerId as OwnerId;
    const sessionRef: SessionRef = { harness: held.harness, sessionId: held.sessionId, generation: held.generation };
    // Resolve the verified session's exact participant without joining a device.
    const inspected = await safeCall(() => deps.agents.inspect({
      ownerId, principal: held.principal ?? null, inviteRef: held.invite, session: sessionRef,
      inviteEvidence: held.inviteEvidence ?? null,
    }));
    if (inspected === null || inspected.kind === 'unavailable' || inspected.kind === 'outcome_unknown') return json(503, { code: 'unavailable' });
    if (inspected.kind === 'rejected') return json(403, { code: 'admission_denied' });
    const address = {
      ownerId, roomId: inspected.value.roomId, agentParticipantId: inspected.value.agentParticipantId,
    };
    const roomIndex = await ownerRooms.inspect(ownerId, address.roomId);
    if (roomIndex.kind !== 'ok') return json(503, { code: 'unavailable' });
    if (roomIndex.value?.marker) return json(403, { code: 'admission_denied' });
    const current = await bindings.findParticipant(address);
    if (current.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (current.kind === 'found') {
      const verdict = bindingVerdict(current.record, held, address.agentParticipantId);
      if (verdict !== 'reuse' && verdict !== 'replace') return json(409, { code: verdict });
    }
    const claimed = await bindings.claimSession({
      ...address, harness: held.harness, sessionId: held.sessionId,
      deviceId: held.deviceId as SessionBinding['deviceId'], generation: held.generation,
    });
    if (claimed.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (claimed.kind === 'conflict') return json(409, { code: 'binding_conflict' });

    let admitted = tracker.redemption!.admitted;
    if (admitted === null) {
      // Independent grants for this verified binding converge on one provider commit.
      const scopedOperationId = `bootstrap-${createHash('sha256').update(JSON.stringify([
        ownerId, address.roomId, address.agentParticipantId, held.deviceId,
        held.harness, held.sessionId, held.generation,
      ])).digest('base64url')}`;
      const result = await safeCall(() => deps.agents.admit({
        ownerId,
        inviteRef: held.invite,
        deviceId: held.deviceId,
        session: sessionRef,
        expectedAgentParticipantId: address.agentParticipantId,
        expectedRoomId: address.roomId,
        operationId: scopedOperationId,
        inviteEvidence: held.inviteEvidence ?? null,
        principal: held.principal ?? null,
      }));
      if (result === null || result.kind === 'unavailable') return json(503, { code: 'unavailable' });
      if (result.kind === 'outcome_unknown') return json(502, { code: 'outcome_unknown' });
      if (result.kind === 'rejected') return json(403, { code: 'admission_denied' });
      if (result.value.roomId !== address.roomId || result.value.agentParticipantId !== address.agentParticipantId) {
        return json(403, { code: 'admission_denied' });
      }
      admitted = { agentParticipantId: result.value.agentParticipantId, roomId: result.value.roomId };
      // Recorded so a retry of this operation resumes here instead of admitting again.
      const recorded = await saveRedemption({ ...tracker.redemption!, admitted });
      if (recorded === 'conflict') return json(401, { code: 'grant_replayed' });
      if (recorded !== 'applied') return json(503, { code: 'unavailable' });
    }
    if (admitted.roomId !== address.roomId || admitted.agentParticipantId !== address.agentParticipantId) {
      return json(403, { code: 'admission_denied' });
    }

    const bound = await bindSession(address, held);
    if (bound.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (bound.kind === 'refused') return json(409, { code: bound.code });
    // This CAS races the close marker in one owner/room record. No capability can
    // reach a binding that closure omitted from its active snapshot.
    const indexed = await ownerRooms.activate(bound.binding, address.roomId);
    if (indexed.kind === 'closed') return json(403, { code: 'admission_denied' });
    if (indexed.kind !== 'ok') return json(503, { code: 'unavailable' });

    const matrixSession = deps.agentDeviceSession
      ? await safeCall(() => deps.agentDeviceSession!.issue(bound.binding, address.roomId))
      : null;
    if (deps.agentDeviceSession && (matrixSession === null || matrixSession.deviceId !== bound.binding.deviceId)) {
      return json(503, { code: 'unavailable' });
    }

    // Pin the original connector proof key before the one-use grant is spent.
    // An expired bearer alone must never authorize a replacement key later.
    const pinned = await pinProofKey(bound.binding, held.jkt, true);
    if (pinned !== 'matched') return json(pinned === 'conflict' ? 409 : 503,
      { code: pinned === 'conflict' ? 'binding_conflict' : 'unavailable' });

    // Spend the grant before minting, so concurrent retries cannot both be issued one.
    const spent = await saveRedemption({ ...tracker.redemption!, issued: true });
    if (spent === 'conflict') return json(401, { code: 'grant_replayed' });
    if (spent !== 'applied') return json(503, { code: 'unavailable' });
    const capability = await issueCapability(ownerId, address.roomId, bound.binding, held.jkt);
    if (capability.kind !== 'issued') return json(capability.kind === 'revoked' ? 409 : 503, { code: capability.kind === 'revoked' ? 'binding_revoked' : 'unavailable' });
    return json(200, {
      binding: bound.binding,
      adapter_capability: {
        token: capability.token, token_type: 'DPoP', scope: [...ADAPTER_CAPABILITIES],
        binding_id: bound.binding.bindingId, generation: bound.binding.generation, expires_at: capability.expiresAt,
      },
      ...(matrixSession ? { matrix_session: matrixSession } : {}),
    });
  }

  /**
   * One binding per owner, room and participant. The same session and device get the
   * same binding back. A revoked binding is never revived: only the same participant,
   * session and device at a later generation gets a new binding ID.
   */
  async function bindSession(
    address: Readonly<{ ownerId: OwnerId; roomId: RoomId; agentParticipantId: ParticipantId }>, held: GrantRecord,
  ): Promise<Readonly<{ kind: 'bound'; binding: SessionBinding }> | Readonly<{ kind: 'refused'; code: BindingRefusal }> | Readonly<{ kind: 'unavailable' }>> {
    const existing = await bindings.findParticipant(address);
    if (existing.kind === 'unavailable') return { kind: 'unavailable' };
    let expectedBindingId: BindingId | null = null;
    if (existing.kind === 'found') {
      const verdict = bindingVerdict(existing.record, held, address.agentParticipantId);
      if (verdict === 'reuse') return { kind: 'bound', binding: existing.record.binding };
      if (verdict !== 'replace') return { kind: 'refused', code: verdict };
      expectedBindingId = existing.record.binding.bindingId;
    }
    const binding: SessionBinding = {
      v: 1, bindingId: `bnd_${randomToken(deps.random, 16)}` as BindingId, ownerId: address.ownerId,
      agentParticipantId: address.agentParticipantId,
      deviceId: held.deviceId as SessionBinding['deviceId'], harness: held.harness, sessionId: held.sessionId, generation: held.generation,
    };
    const record: BindingRecord = { binding, revokedGeneration: null, capability: null };
    const written = await bindings.putParticipant({ ...address, expectedBindingId, record });
    if (written.kind === 'applied') return { kind: 'bound', binding: written.record.binding };
    if (written.kind === 'conflict' && written.record) {
      const verdict = bindingVerdict(written.record, held, address.agentParticipantId);
      if (verdict === 'reuse') return { kind: 'bound', binding: written.record.binding };
      return { kind: 'refused', code: verdict === 'replace' ? 'binding_conflict' : verdict };
    }
    return written.kind === 'conflict' ? { kind: 'refused', code: 'binding_conflict' } : { kind: 'unavailable' };
  }

  /** Mints the binding's only accepted capability. An earlier one for the binding stops working. */
  async function pinProofKey(binding: SessionBinding, jkt: string, create = false): Promise<'matched' | 'conflict' | 'unavailable'> {
    const proofKey = key('adapter-proof-key', binding.bindingId);
    const desired = { bindingId: binding.bindingId, generation: binding.generation, deviceId: binding.deviceId, jkt };
    const seen = await store.read<JsonValue>(proofKey);
    if (seen.kind === 'unavailable') return 'unavailable';
    if (seen.kind === 'record') return sameJsonValue(seen.record.value, desired) ? 'matched' : 'conflict';
    if (!create) return 'conflict';
    const stored = await settleWrite<JsonValue>(store, { key: proofKey, expectedRevision: null,
      operationId: `adapter-proof-key.${binding.bindingId}.${binding.generation}`,
      next: { value: desired, expiresAt: null } });
    if (stored.kind === 'applied') return 'matched';
    if (stored.kind === 'conflict') return stored.current && sameJsonValue(stored.current.value, desired) ? 'matched' : 'conflict';
    return 'unavailable';
  }

  async function issueCapability(
    ownerId: OwnerId, roomId: RoomId, binding: SessionBinding, jkt: string,
    planned?: Readonly<{ token: string; expiresAt: number; operationId: string; previousCapability: string }>,
  ): Promise<Readonly<{ kind: 'issued'; token: string; expiresAt: number }> | Readonly<{ kind: 'revoked' | 'conflict' | 'unavailable' }>> {
    const capability = planned?.token ?? randomToken(deps.random, 32);
    const expiresAt = planned?.expiresAt ?? deps.clock() + CAPABILITY_TTL_MS;
    if (!TOKEN.test(capability) || expiresAt <= deps.clock()) return { kind: 'unavailable' };
    const value: CapabilityRecord = {
      ownerId, roomId, bindingId: binding.bindingId, generation: binding.generation, jkt, scope: [...ADAPTER_CAPABILITIES],
    };
    const written = await settleWrite<JsonValue>(store, {
      key: key('capability', capability), expectedRevision: null,
      operationId: planned ? `capability-refresh.${planned.operationId}` : `capability-${randomToken(deps.random, 16)}`,
      next: { value, expiresAt: new Date(expiresAt).toISOString() },
    });
    if (written.kind !== 'applied' && (written.kind !== 'conflict' || !written.current
      || !sameJsonValue(written.current.value, value as unknown as JsonValue)
      || written.current.expiresAt !== new Date(expiresAt).toISOString())) return { kind: 'unavailable' };
    let conflict = false;
    const pointed = await bindings.updateBinding(binding.bindingId, record => {
      if (record.revokedGeneration !== null || record.capability === digest(capability)) return null;
      if (planned && record.capability !== planned.previousCapability) {
        conflict = true;
        return null;
      }
      return { ...record, capability: digest(capability) };
    });
    if (conflict) return { kind: 'conflict' };
    if (pointed === 'applied') return { kind: 'issued', token: capability, expiresAt };
    if (pointed === 'unchanged') {
      const current = await bindings.findBinding(binding.bindingId);
      if (current.kind === 'found' && current.record.revokedGeneration === null
        && current.record.capability === digest(capability)) return { kind: 'issued', token: capability, expiresAt };
    }
    return { kind: pointed === 'unchanged' ? 'revoked' : 'unavailable' };
  }

  const capabilities: AdapterCapabilities = {
    async authorizeRevocationCleanup(request) {
      const refuse = (status: 401 | 403, code: AdapterRefusal) => ({ kind: 'refused', status, code }) as const;
      const presented = bearer(request);
      if (presented === null) return refuse(401, 'capability_required');
      const read = await store.read<CapabilityRecord>(key('capability', presented));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      let held: CapabilityRecord;
      if (read.kind === 'absent') {
        // The ordinary capability envelope expires after an hour. Its prepared
        // revocation cleanup is durable and may be retried much later, but only
        // by the original pinned proof key and token digest.
        const bindingId = request.headers.get('x-khala-binding-id');
        if (!bindingId || !OPERATION_ID.test(bindingId)) return refuse(401, 'invalid_capability');
        const located = await bindings.locateBinding(bindingId);
        if (located.kind === 'unavailable') return { kind: 'unavailable' };
        if (located.kind !== 'found' || located.record.revokedGeneration !== located.record.binding.generation + 1) {
          return refuse(401, 'binding_superseded');
        }
        const jkt = proofKeyThumbprint(request.headers.get('dpop'));
        if (!jkt || await pinProofKey(located.record.binding, jkt) !== 'matched') return refuse(401, 'proof_key_mismatch');
        held = { ownerId: located.address.ownerId, roomId: located.address.roomId,
          bindingId, generation: located.record.binding.generation, jkt, scope: [] };
      } else held = read.record.value;
      let target: URL;
      try { target = new URL(request.url); } catch { return refuse(401, 'proof_target_mismatch'); }
      if (target.origin !== deps.origin || ![
        '/api/agent/revocation/cleanup', '/api/agent/revocation/result',
      ].includes(target.pathname)) return refuse(401, 'proof_target_mismatch');
      const proof = await checkFreshProof(request, { method: request.method,
        url: `${deps.origin}${target.pathname}`, jkt: held.jkt, accessToken: presented });
      if (proof === 'unavailable') return { kind: 'unavailable' };
      if (proof !== null) return refuse(401, proof);
      const found = await bindings.locateBinding(held.bindingId);
      if (found.kind === 'unavailable') return { kind: 'unavailable' };
      if (found.kind !== 'found') return refuse(401, 'binding_superseded');
      const { binding, revokedGeneration } = found.record;
      if (binding.ownerId !== held.ownerId || found.address.roomId !== held.roomId
        || binding.bindingId !== held.bindingId
        || binding.generation !== held.generation || revokedGeneration !== held.generation + 1) {
        return refuse(401, 'binding_superseded');
      }
      return { kind: 'authorized', ownerId: binding.ownerId, roomId: found.address.roomId,
        binding, revokedGeneration, capabilityDigest: digest(presented) };
    },
    async authorize(request, action) {
      const refuse = (status: 401 | 403, code: AdapterRefusal) => ({ kind: 'refused', status, code }) as const;
      const presented = bearer(request);
      if (presented === null) return refuse(401, 'capability_required');
      const read = await store.read<CapabilityRecord>(key('capability', presented));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind === 'absent') return refuse(401, 'invalid_capability');
      const held = read.record.value;
      let target: URL;
      try {
        target = new URL(request.url);
      } catch {
        return refuse(401, 'proof_target_mismatch');
      }
      if (target.origin !== deps.origin) return refuse(401, 'proof_target_mismatch');
      const proof = await checkFreshProof(request, {
        method: request.method, url: `${deps.origin}${target.pathname}`, jkt: held.jkt, accessToken: presented,
      });
      if (proof === 'unavailable') return { kind: 'unavailable' };
      if (proof !== null) return refuse(401, proof);
      if (!(ADAPTER_CAPABILITIES as readonly string[]).includes(action) || !held.scope.includes(action)) return refuse(403, 'capability_not_granted');
      const current = await bindings.findBinding(held.bindingId);
      if (current.kind === 'unavailable') return { kind: 'unavailable' };
      if (current.kind === 'absent') return refuse(401, 'binding_superseded');
      if (current.kind !== 'found') return { kind: 'unavailable' };
      const record = current.record;
      if (record.binding.ownerId !== held.ownerId || record.binding.bindingId !== held.bindingId
        || record.binding.generation !== held.generation) return refuse(401, 'binding_superseded');
      if (record.revokedGeneration !== null) return refuse(401, 'binding_revoked');
      if (record.capability === null || !safeEqual(record.capability, digest(presented))) return refuse(401, 'binding_superseded');
      return { kind: 'authorized', action: action as AdapterAction, ownerId: held.ownerId as OwnerId, roomId: held.roomId as RoomId, binding: record.binding };
    },

    async resumeAdapterCapability(input) {
      const located = await bindings.locateBinding(input.bindingId);
      if (located.kind === 'unavailable') return { kind: 'unavailable' };
      if (located.kind !== 'found') return { kind: 'refused', code: 'binding_conflict' };
      const { binding } = located.record;
      if (binding.ownerId !== input.ownerId || binding.deviceId !== input.deviceId || binding.generation !== input.generation) {
        return { kind: 'refused', code: 'binding_conflict' };
      }
      if (located.record.revokedGeneration !== null) return { kind: 'refused', code: 'binding_revoked' };
      if (input.planned && located.record.capability !== input.planned.previousCapability
        && located.record.capability !== digest(input.planned.token)) return { kind: 'refused', code: 'binding_conflict' };
      const pinned = await pinProofKey(binding, input.jkt);
      if (pinned === 'conflict') return { kind: 'refused', code: 'binding_conflict' };
      if (pinned !== 'matched') return { kind: 'unavailable' };
      const issued = await issueCapability(input.ownerId, located.address.roomId, binding, input.jkt, input.planned);
      if (issued.kind === 'revoked') return { kind: 'refused', code: 'binding_revoked' };
      if (issued.kind === 'conflict') return { kind: 'refused', code: 'binding_conflict' };
      if (issued.kind !== 'issued') return { kind: 'unavailable' };
      return { kind: 'resumed', binding, capability: { token: issued.token, scope: ADAPTER_CAPABILITIES, expiresAt: issued.expiresAt } };
    },

    async lookupBinding(bindingId) {
      if (typeof bindingId !== 'string') return { kind: 'absent' };
      const found = await bindings.findBinding(bindingId);
      if (found.kind !== 'found') return found;
      const { binding, revokedGeneration } = found.record;
      return {
        kind: 'found', ownerId: binding.ownerId, deviceId: binding.deviceId,
        generation: revokedGeneration ?? binding.generation, status: revokedGeneration === null ? 'active' : 'revoked',
      };
    },

    async disableBinding(input) {
      if (typeof input?.bindingId !== 'string' || !Number.isSafeInteger(input.expectedGeneration)
        || !Number.isSafeInteger(input.revokedGeneration) || input.revokedGeneration <= input.expectedGeneration) {
        return { kind: 'unavailable' };
      }
      const { expectedGeneration, revokedGeneration } = input;
      let stale = false;
      const result = await bindings.updateBinding(input.bindingId, record => {
        stale = false;
        if (record.revokedGeneration === revokedGeneration) return null;
        if (record.revokedGeneration !== null || record.binding.generation !== expectedGeneration) {
          stale = true;
          return null;
        }
        return { ...record, revokedGeneration, capability: null };
      });
      if (result === 'unavailable') return { kind: 'unavailable' };
      if (result === 'absent' || stale) return { kind: 'stale' };
      return { kind: 'applied' };
    },

    async revokeAdapterCapability(input) {
      if (typeof input?.bindingId !== 'string' || !Number.isSafeInteger(input.revokedGeneration) || input.revokedGeneration < 0) {
        return { kind: 'unavailable' };
      }
      const revokedGeneration = input.revokedGeneration;
      const result = await bindings.updateBinding(input.bindingId, record => (
        record.revokedGeneration === null ? { ...record, revokedGeneration, capability: null } : null
      ));
      // `absent`: this binding was replaced, and its capabilities no longer match it.
      return { kind: result === 'unavailable' ? 'unavailable' : 'applied' };
    },
  };

  /** Verifies the proof, then records its `jti` once. Returns a response only on failure. */
  async function verifyFreshProof(request: Request, expected: Readonly<{
    method: string; url: string; jkt: string; accessToken?: string; nonce?: string; bodyHash?: string;
  }>): Promise<Response | null> {
    const checked = await checkFreshProof(request, expected);
    if (checked === null) return null;
    return checked === 'unavailable' ? json(503, { code: 'unavailable' }) : json(401, { code: checked });
  }

  async function checkFreshProof(
    request: Request, expected: Readonly<{
      method: string; url: string; jkt: string; accessToken?: string; nonce?: string; bodyHash?: string;
    }>,
  ): Promise<ProofRefusal | 'proof_replayed' | 'unavailable' | null> {
    const nowMs = deps.clock();
    const checked = checkProof(request.headers.get('dpop'), { ...expected, nowMs });
    if (checked.kind === 'invalid') return checked.code;
    const recorded = await settleWrite<JsonValue>(store, {
      key: key('proof', `${expected.jkt}.${checked.jti}`), expectedRevision: null, operationId: `proof-${randomToken(deps.random, 16)}`,
      next: { value: true, expiresAt: new Date(nowMs + PROOF_REPLAY_TTL_MS).toISOString() },
    });
    if (recorded.kind === 'conflict') return 'proof_replayed';
    if (recorded.kind !== 'applied') return 'unavailable';
    return null;
  }

  /** Sign-in, then back to the consent page for the same request. */
  function signIn(params: AuthorizeParams): Response {
    const returnPath = `${AUTHORIZE_PATH}?${authorizeQuery(params)}`;
    if (!isSameOriginReturnPath(returnPath)) return json(400, { code: 'invalid_request' });
    return redirect(`${deps.origin}${LOGIN_PATH}?return_to=${encodeURIComponent(returnPath)}`);
  }

  return {
    agent: [
      { path: DESCRIPTOR_PATH, methods: ['GET'], handle: describe },
      { path: TOKEN_PATH, methods: ['POST'], handle: token },
      { path: REDEEM_PATH, methods: ['POST'], handle: redeem },
      { path: REFRESH_CHALLENGE_PATH, methods: ['GET'], handle: refreshChallenge },
      { path: REFRESH_PATH, methods: ['POST'], handle: refresh },
    ],
    human: [{ path: AUTHORIZE_PATH, methods: ['GET', 'POST'], handle: request => (request.method === 'POST' ? authorize(request) : consent(request)) }],
    capabilities,
  };
}

type ProofRefusal = Extract<ProofCheck, { kind: 'invalid' }>['code'];

/**
 * - `reuse`: the binding is current and already names this session and device.
 * - `replace`: the binding was revoked and this session is at a later generation.
 */
type BindingVerdict = 'reuse' | 'replace' | BindingRefusal;
type BindingRefusal = 'binding_conflict' | 'binding_revoked';

function bindingVerdict(record: BindingRecord, held: GrantRecord, agentParticipantId: ParticipantId): BindingVerdict {
  const { binding, revokedGeneration } = record;
  const sameIdentity = binding.ownerId === held.ownerId && binding.deviceId === held.deviceId
    && binding.harness === held.harness && binding.sessionId === held.sessionId
    && binding.agentParticipantId === agentParticipantId;
  if (revokedGeneration !== null) {
    if (!sameIdentity) return 'binding_conflict';
    // The revoked generation is the first one a replacement may use, so a harness bumps its generation once.
    return held.generation > binding.generation && held.generation >= revokedGeneration ? 'replace' : 'binding_revoked';
  }
  return sameIdentity && binding.generation === held.generation ? 'reuse' : 'binding_conflict';
}

type AuthorizeParams = Readonly<{
  invite: string; session: SessionRef; deviceId: string; jkt: string; redirectUri: string; challenge: string; state: string;
}>;

function readAuthorizeParams(query: URLSearchParams): AuthorizeParams | null {
  const get = (name: string) => {
    const values = query.getAll(name);
    return values.length === 1 ? values[0]! : null;
  };
  const redirectUri = get('redirect_uri');
  const invite = get('invite');
  const harness = get('harness');
  const sessionId = get('session_id');
  const generation = get('generation');
  const deviceId = get('device_id');
  const jkt = get('jkt');
  const challenge = get('code_challenge');
  const state = get('state');
  if (redirectUri === null || !isLoopbackRedirect(redirectUri) || !isText(invite) || harness === null || !HARNESS.test(harness)
    || !isText(sessionId) || generation === null || !/^(0|[1-9][0-9]{0,15})$/.test(generation) || !Number.isSafeInteger(Number(generation))
    || deviceId === null || !DEVICE_ID.test(deviceId) || jkt === null || !B64URL_43.test(jkt)
    || challenge === null || !B64URL_43.test(challenge) || get('code_challenge_method') !== 'S256' || state === null || !STATE.test(state)) {
    return null;
  }
  return { invite, session: { harness, sessionId, generation: Number(generation) }, deviceId, jkt, redirectUri, challenge, state };
}

function authorizeQuery(params: AuthorizeParams): string {
  return new URLSearchParams({
    invite: params.invite, harness: params.session.harness, session_id: params.session.sessionId,
    generation: String(params.session.generation), device_id: params.deviceId, jkt: params.jkt,
    redirect_uri: params.redirectUri, code_challenge: params.challenge, code_challenge_method: 'S256', state: params.state,
  }).toString();
}

/** RFC 8252 loopback redirect: `http`, an IP literal (never `localhost`), an explicit port, no userinfo or fragment. */
export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== ''
    && url.username === '' && url.password === '' && url.hash === '' && url.search === '';
}

function readSession(body: Record<string, unknown>): SessionRef | null {
  const { harness, session_id: sessionId, generation } = body;
  if (typeof harness !== 'string' || !HARNESS.test(harness) || !isText(sessionId)
    || !Number.isSafeInteger(generation) || (generation as number) < 0) return null;
  return { harness, sessionId, generation: generation as number };
}

function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.harness === b.harness && a.sessionId === b.sessionId && a.generation === b.generation;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);
}

/** Store keys never contain a raw secret: codes, grants and capabilities are hashed, other parts digested. */
function key(kind: 'code' | 'grant' | 'proof' | 'capability' | 'adapter-proof-key' | 'refresh-challenge' | 'refresh-slot', value: string): string {
  return `agent-bootstrap:${kind}:${createHash('sha256').update(`khala.agent-bootstrap.${kind}.v1\u0000${value}`).digest('hex')}`;
}

/** What a binding record keeps of its current capability: never the capability itself. */
function digest(capability: string): string {
  return createHash('sha256').update(`khala.agent-bootstrap.capability-ref.v1\u0000${capability}`).digest('base64url');
}

/** `Authorization: DPoP <token>`, for a token minted by `randomToken(random, 32)`. */
function bearer(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('DPoP ') ? authorization.slice(5) : '';
  return TOKEN.test(token) ? token : null;
}

/** Channel-access exchange grants have their own fixed prefix and length. */
function channelGrantBearer(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('DPoP ') ? authorization.slice(5) : '';
  return /^cagrant_[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  try {
    const value: unknown = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Runs an injected port; a throw is `null`, and its message is dropped. */
async function safeCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

function safeInvoke<T>(call: () => T): T | null {
  try {
    return call();
  } catch {
    return null;
  }
}

const BASE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json' } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, location } });
}

/**
 * The owner's confirmation step. Every value is escaped; the page loads nothing, runs
 * nothing and cannot be framed.
 */
function consentPage(params: AuthorizeParams, csrfToken: string): Response {
  const fields = [...new URLSearchParams(authorizeQuery(params)).entries(), ['csrf', csrfToken]]
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name!)}" value="${escapeHtml(value!)}">`).join('');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect your agent</title></head><body>
<h1>Connect your agent to this channel?</h1>
<p>An agent session on this computer asked to join the channel as your agent.
Continue only if you just gave the link to your own agent.</p>
<dl><dt>Harness</dt><dd>${escapeHtml(params.session.harness)}</dd><dt>Session</dt><dd>${escapeHtml(params.session.sessionId)}</dd>
<dt>Device</dt><dd>${escapeHtml(params.deviceId)}</dd></dl>
<form method="post" action="${AUTHORIZE_PATH}">${fields}
<button type="submit" name="decision" value="allow">Connect</button>
<button type="submit" name="decision" value="deny">Cancel</button></form></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function loopback(redirectUri: string, params: Record<string, string>): Response {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
  return redirect(target.href);
}
