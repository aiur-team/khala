// Hosted side of agent-operated link bootstrap (KHA-114), the candidate trust
// path proved by KHA-144:
//
// 1. `GET  /api/agent/bootstrap/descriptor`  public; names the invite and methods only.
// 2. `GET  /api/human/agent-bootstrap/authorize`  the owner's own browser. The session
//    cookie is the owner evidence. A one-time code goes to a loopback redirect.
// 3. `POST /api/agent/bootstrap/token`  code + PKCE + key proof → 60 s bootstrap grant.
// 4. `POST /api/agent/bootstrap/redeem`  grant + key proof → session binding and a
//    short-lived device credential.
//
// A link grants nothing. The owner comes only from the authenticated session. The
// grant only admits this device for this session; it cannot approve or release
// messages or act as the human. Every response is a finite code.

import { createHash } from 'node:crypto';
import {
  type AdmissionPort, type AdmissionRejection, type AuthPrincipal, type ControlStore, type JsonValue, type OperationResult,
  type OwnerId, type ParticipantId, type RoomId, type SessionBinding, type TrustedClock, isSameOriginReturnPath,
} from '@khala/contracts/messaging/index';
import type { Authentication } from '../auth/index';
import { LOGIN_PATH } from '../auth/callback';
import { safeEqual } from '../auth/csrf';
import { type Random, guardStore, randomToken, settleWrite } from '../auth/store';
import type { RouteRegistration } from '../runtime/handler';
import { checkProof } from './proof';

export const DESCRIPTOR_PATH = '/api/agent/bootstrap/descriptor';
export const AUTHORIZE_PATH = '/api/human/agent-bootstrap/authorize';
export const TOKEN_PATH = '/api/agent/bootstrap/token';
export const REDEEM_PATH = '/api/agent/bootstrap/redeem';
export const OWNERSHIP_METHOD = 'loopback-browser-v1';

/** Lifetime of a one-time code and of a bootstrap grant (KHA-144: 60 s each). */
export const CODE_TTL_MS = 60_000;
export const GRANT_TTL_MS = 60_000;
/** Replay window for proof `jti`s: longer than a proof's accepted age plus skew. */
const PROOF_REPLAY_TTL_MS = 120_000;

/** The G-ADMISSION decision: whether this signed-in human may bind an agent through this invite. */
export type AdmissionPolicy = (input: Readonly<{ principal: AuthPrincipal; inviteRef: string; session: SessionRef }>) => Promise<'allow' | 'deny'>;

/**
 * Admits the owner's agent participant, with this device, into the invite's room
 * (KHA-113 / G-SUBSTRATE). `room` resolves an invite without side effects, so a
 * binding conflict is refused before any device joins. `admit` receives an
 * operation ID already scoped to the owner and device.
 */
export interface AgentAdmissionPort {
  room(inviteRef: string): Promise<OperationResult<RoomId, AdmissionRejection>>;
  admit(input: Readonly<{ ownerId: OwnerId; inviteRef: string; deviceId: string; operationId: string }>): Promise<
    OperationResult<Readonly<{ agentParticipantId: ParticipantId; roomId: RoomId }>, AdmissionRejection>
  >;
}

/**
 * Issues short-lived material the connector uses to create or resume exactly this
 * device for the agent participant (for example a substrate login token). Issuing
 * again for the same device must never create a second device.
 */
export interface DeviceCredentialPort {
  issue(input: Readonly<{ ownerId: OwnerId; agentParticipantId: ParticipantId; deviceId: string }>): Promise<
    OperationResult<Readonly<{ secret: string; expiresAt: number }>, 'forbidden'>
  >;
}

export type AgentBootstrapDeps = Readonly<{
  /** Exact public origin, e.g. `https://khala.aiur.team`. */
  origin: string;
  store: ControlStore;
  clock: TrustedClock;
  random: Random;
  /** KHA-110 `AuthService.authenticateRequest`. */
  authenticate(request: Request): Promise<Authentication>;
  /** KHA-132 route codec: the invite a share link names, or `null`. */
  inviteFromLink(url: URL): string | null;
  /** Request-scoped KHA-105 admission port for the signed-in owner. */
  admissionFor(request: Request): Pick<AdmissionPort, 'inspect'>;
  /** No default: the deployment must decide G-ADMISSION explicitly. */
  admissionPolicy: AdmissionPolicy;
  agents: AgentAdmissionPort;
  devices: DeviceCredentialPort;
}>;

export type SessionRef = Readonly<{ harness: string; sessionId: string; generation: number }>;

type CodeRecord = {
  ownerId: string; invite: string; harness: string; sessionId: string; generation: number;
  deviceId: string; jkt: string; challenge: string; used: boolean;
};
type GrantRecord = {
  ownerId: string; invite: string; harness: string; sessionId: string; generation: number;
  deviceId: string; jkt: string; redeemedBy: string | null;
};

const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[A-Za-z0-9._~-]{16,128}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TEXT_BYTES = 512;

export type AgentBootstrapHandlers = Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[] }>;

/** Route registrations for the human (`/api/human/`) and agent (`/api/agent/`) domains. */
export function createAgentBootstrapHandlers(deps: AgentBootstrapDeps): AgentBootstrapHandlers {
  const origin = new URL(deps.origin);
  if (origin.protocol !== 'https:' || origin.origin !== deps.origin) throw new Error('bootstrap origin must be an exact https origin');
  if (typeof deps.admissionPolicy !== 'function') throw new Error('an explicit admission policy is required (G-ADMISSION)');
  const store = guardStore(deps.store);
  const tokenUrl = `${deps.origin}${TOKEN_PATH}`;
  const redeemUrl = `${deps.origin}${REDEEM_PATH}`;

  async function describe(request: Request): Promise<Response> {
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

  async function authorize(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const params = readAuthorizeParams(url.searchParams);
    // Without a valid loopback redirect there is nowhere safe to send an answer.
    if (!params) return json(400, { code: 'invalid_request' });
    const auth = await deps.authenticate(request).catch(() => ({ kind: 'unavailable' }) as const);
    if (auth.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (auth.kind === 'signed_out') return signIn(url);
    const { principal } = auth.context;
    const deny = (error: string) => loopback(params.redirectUri, { error, state: params.state });

    const invite = await safeCall(() => deps.admissionFor(request).inspect(params.invite));
    if (invite === null || invite === 'unavailable') return json(503, { code: 'unavailable' });
    if (invite === 'auth_required') return signIn(url);
    if (invite === 'expired' || invite === 'revoked') return deny('invite_unavailable');
    if (invite !== 'eligible' && invite !== 'already_joined') return deny('access_denied');
    const decision = await safeCall(() => deps.admissionPolicy({ principal, inviteRef: params.invite, session: params.session }));
    if (decision === null) return json(503, { code: 'unavailable' });
    if (decision !== 'allow') return deny('access_denied');

    const code = randomToken(deps.random, 32);
    const now = deps.clock();
    const value: CodeRecord = {
      ownerId: principal.ownerId, invite: params.invite, ...params.session, deviceId: params.deviceId,
      jkt: params.jkt, challenge: params.challenge, used: false,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: key('code', code), expectedRevision: null, operationId: `code-${randomToken(deps.random, 16)}`,
      next: { value, expiresAt: new Date(now + CODE_TTL_MS).toISOString() },
    });
    if (written.kind !== 'applied') return json(503, { code: 'unavailable' });
    return loopback(params.redirectUri, { code, state: params.state });
  }

  async function token(request: Request): Promise<Response> {
    const body = await readBody(request);
    const session = body && readSession(body);
    if (!body || !session || typeof body.code !== 'string' || !TOKEN.test(body.code) || typeof body.code_verifier !== 'string'
      || !VERIFIER.test(body.code_verifier) || typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id)) {
      return json(400, { code: 'invalid_request' });
    }
    const codeKey = key('code', body.code);
    const read = await store.read<CodeRecord>(codeKey);
    if (read.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (read.kind === 'absent' || read.record.value.used) return json(400, { code: 'invalid_grant' });
    const pending = read.record.value;
    // Consume before checking anything else, so a wrong verifier or key burns the code.
    const consumed = await settleWrite<JsonValue>(store, {
      key: codeKey, expectedRevision: read.record.revision, operationId: `consume-${randomToken(deps.random, 16)}`,
      next: { value: { ...pending, used: true }, expiresAt: read.record.expiresAt },
    });
    if (consumed.kind === 'conflict') return json(400, { code: 'invalid_grant' });
    if (consumed.kind !== 'applied') return json(503, { code: 'unavailable' });
    const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
    if (!safeEqual(challenge, pending.challenge) || !sameSession(pending, session) || pending.deviceId !== body.device_id) {
      return json(400, { code: 'invalid_grant' });
    }
    const proof = await verifyFreshProof(request, { method: 'POST', url: tokenUrl, jkt: pending.jkt });
    if (proof) return proof;

    const grant = randomToken(deps.random, 32);
    const expiresAt = deps.clock() + GRANT_TTL_MS;
    const value: GrantRecord = {
      ownerId: pending.ownerId, invite: pending.invite, harness: pending.harness, sessionId: pending.sessionId,
      generation: pending.generation, deviceId: pending.deviceId, jkt: pending.jkt, redeemedBy: null,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: key('grant', grant), expectedRevision: null, operationId: `grant-${randomToken(deps.random, 16)}`,
      next: { value, expiresAt: new Date(expiresAt).toISOString() },
    });
    if (written.kind !== 'applied') return json(503, { code: 'unavailable' });
    return json(200, { grant, expires_at: expiresAt });
  }

  async function redeem(request: Request): Promise<Response> {
    const authorization = request.headers.get('authorization') ?? '';
    const grant = authorization.startsWith('DPoP ') ? authorization.slice(5) : '';
    const body = await readBody(request);
    const session = body && readSession(body);
    if (!TOKEN.test(grant)) return json(401, { code: 'invalid_grant' });
    if (!body || !session || typeof body.operation_id !== 'string' || !OPERATION_ID.test(body.operation_id)
      || typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id)) {
      return json(400, { code: 'invalid_request' });
    }
    const operationId = body.operation_id;
    const grantKey = key('grant', grant);
    const read = await store.read<GrantRecord>(grantKey);
    if (read.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (read.kind === 'absent') return json(401, { code: 'invalid_grant' });
    const held = read.record.value;
    const proof = await verifyFreshProof(request, { method: 'POST', url: redeemUrl, jkt: held.jkt, accessToken: grant });
    if (proof) return proof;
    if (!sameSession(held, session) || held.deviceId !== body.device_id) return json(401, { code: 'invalid_grant' });
    if (held.redeemedBy === null) {
      const claimed = await settleWrite<JsonValue>(store, {
        key: grantKey, expectedRevision: read.record.revision, operationId: `redeem-${operationId}-${randomToken(deps.random, 8)}`,
        next: { value: { ...held, redeemedBy: operationId }, expiresAt: read.record.expiresAt },
      });
      if (claimed.kind === 'unavailable') return json(503, { code: 'unavailable' });
      const winner = claimed.kind === 'applied' ? operationId : (claimed.current?.value as GrantRecord | undefined)?.redeemedBy;
      if (winner !== operationId) return json(401, { code: 'grant_replayed' });
    } else if (held.redeemedBy !== operationId) {
      // Only a lost-response retry of the same operation may present a grant again.
      return json(401, { code: 'grant_replayed' });
    }

    const ownerId = held.ownerId as OwnerId;
    // Refuse a takeover before the device joins anything.
    const room = await safeCall(() => deps.agents.room(held.invite));
    if (room === null || room.kind === 'unavailable' || room.kind === 'outcome_unknown') return json(503, { code: 'unavailable' });
    if (room.kind === 'rejected') return json(403, { code: 'admission_denied' });
    const current = await store.read<SessionBinding>(bindingKey(ownerId, room.value));
    if (current.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (current.kind === 'record' && !(current.record.value.deviceId === held.deviceId && sameSession(current.record.value, held))) {
      return json(409, { code: 'binding_conflict' });
    }

    // A client-chosen ID never reaches the port unscoped, so owners cannot collide on it.
    const scopedOperationId = `bootstrap-${createHash('sha256').update(JSON.stringify([ownerId, held.deviceId, operationId])).digest('base64url')}`;
    const admitted = await safeCall(() => deps.agents.admit({ ownerId, inviteRef: held.invite, deviceId: held.deviceId, operationId: scopedOperationId }));
    if (admitted === null || admitted.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (admitted.kind === 'outcome_unknown') return json(502, { code: 'outcome_unknown' });
    if (admitted.kind === 'rejected') return json(403, { code: 'admission_denied' });
    const { agentParticipantId, roomId } = admitted.value;
    if (roomId !== room.value) return json(403, { code: 'admission_denied' });

    const bound = await bindSession(ownerId, roomId, agentParticipantId, held, operationId);
    if (bound.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (bound.kind === 'conflict') return json(409, { code: 'binding_conflict' });

    const credential = await safeCall(() => deps.devices.issue({ ownerId, agentParticipantId, deviceId: held.deviceId }));
    if (credential === null || credential.kind === 'unavailable' || credential.kind === 'outcome_unknown') return json(503, { code: 'unavailable' });
    if (credential.kind === 'rejected') return json(403, { code: 'admission_denied' });
    return json(200, { binding: bound.binding, device_credential: { secret: credential.value.secret, expires_at: credential.value.expiresAt } });
  }

  /**
   * One immutable binding per owner and room. The same session and device get the
   * same binding back; anything else needs an explicit owner rebinding flow.
   */
  async function bindSession(
    ownerId: OwnerId, roomId: RoomId, agentParticipantId: ParticipantId, held: GrantRecord, operationId: string,
  ): Promise<Readonly<{ kind: 'bound'; binding: SessionBinding }> | Readonly<{ kind: 'conflict' }> | Readonly<{ kind: 'unavailable' }>> {
    const storeKey = bindingKey(ownerId, roomId);
    const matches = (binding: SessionBinding) => binding.ownerId === ownerId && binding.agentParticipantId === agentParticipantId
      && binding.deviceId === held.deviceId && sameSession(binding, held);
    const existing = await store.read<SessionBinding>(storeKey);
    if (existing.kind === 'unavailable') return { kind: 'unavailable' };
    if (existing.kind === 'record') return matches(existing.record.value) ? { kind: 'bound', binding: existing.record.value } : { kind: 'conflict' };
    const binding: SessionBinding = {
      v: 1, bindingId: `bnd_${randomToken(deps.random, 16)}` as SessionBinding['bindingId'], ownerId, agentParticipantId,
      deviceId: held.deviceId as SessionBinding['deviceId'], harness: held.harness, sessionId: held.sessionId, generation: held.generation,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: storeKey, expectedRevision: null, operationId: `bind-${operationId}-${randomToken(deps.random, 8)}`,
      next: { value: binding, expiresAt: null },
    });
    if (written.kind === 'applied') return { kind: 'bound', binding };
    if (written.kind === 'conflict' && written.current) {
      const current = written.current.value as SessionBinding;
      return matches(current) ? { kind: 'bound', binding: current } : { kind: 'conflict' };
    }
    return { kind: 'unavailable' };
  }

  /** Verifies the proof, then records its `jti` once. Returns a response only on failure. */
  async function verifyFreshProof(request: Request, expected: Readonly<{ method: string; url: string; jkt: string; accessToken?: string }>): Promise<Response | null> {
    const nowMs = deps.clock();
    const checked = checkProof(request.headers.get('dpop'), { ...expected, nowMs });
    if (checked.kind === 'invalid') return json(401, { code: checked.code });
    const recorded = await settleWrite<JsonValue>(store, {
      key: key('proof', `${expected.jkt}.${checked.jti}`), expectedRevision: null, operationId: `proof-${randomToken(deps.random, 16)}`,
      next: { value: true, expiresAt: new Date(nowMs + PROOF_REPLAY_TTL_MS).toISOString() },
    });
    if (recorded.kind === 'conflict') return json(401, { code: 'proof_replayed' });
    if (recorded.kind !== 'applied') return json(503, { code: 'unavailable' });
    return null;
  }

  function signIn(url: URL): Response {
    const returnPath = `${url.pathname}${url.search}`;
    if (!isSameOriginReturnPath(returnPath)) return json(400, { code: 'invalid_request' });
    return redirect(`${deps.origin}${LOGIN_PATH}?return_to=${encodeURIComponent(returnPath)}`);
  }

  return {
    agent: [
      { path: DESCRIPTOR_PATH, methods: ['GET'], handle: describe },
      { path: TOKEN_PATH, methods: ['POST'], handle: token },
      { path: REDEEM_PATH, methods: ['POST'], handle: redeem },
    ],
    human: [{ path: AUTHORIZE_PATH, methods: ['GET'], handle: authorize }],
  };
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

/** Store keys never contain a raw secret: codes and grants are hashed, other parts digested. */
function key(kind: 'code' | 'grant' | 'proof' | 'binding', value: string): string {
  return `agent-bootstrap:${kind}:${createHash('sha256').update(`khala.agent-bootstrap.${kind}.v1\u0000${value}`).digest('hex')}`;
}

function bindingKey(ownerId: OwnerId, roomId: RoomId): string {
  return key('binding', JSON.stringify([ownerId, roomId]));
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

function loopback(redirectUri: string, params: Record<string, string>): Response {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
  return redirect(target.href);
}
