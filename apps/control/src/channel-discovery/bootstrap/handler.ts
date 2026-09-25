import { createHash } from 'node:crypto';
import {
  CHANNEL_DISCOVERY_SCOPES,
  type ControlStore,
  type DiscoveryCredential,
  type DiscoveryRequester,
  type DiscoveryScope,
  type JsonValue,
  type OwnerId,
  type StableAgentPrincipal,
  type TrustedClock,
  isSameOriginReturnPath,
} from '@khala/contracts/messaging/index';
import type { Authentication } from '../../auth/index';
import { LOGIN_PATH } from '../../auth/callback';
import { checkMutationOrigin, csrfMatches, safeEqual } from '../../auth/csrf';
import { type Random, guardStore, randomToken, settleWrite } from '../../auth/store';
import { type ProofCheck, checkProof } from '../../agent-bootstrap/proof';
import type { RouteRegistration } from '../../runtime/handler';
import { credentialRef, digestDiscoverySecret, discoveryStoreKeys, parseCredentialRef } from './store';

export const AUTHORIZE_PATH = '/api/human/channel-discovery/bootstrap/authorize';
export const TOKEN_PATH = '/api/agent/channel-discovery/bootstrap/token';
export const CODE_TTL_MS = 60_000;
export const CREDENTIAL_TTL_MS = 300_000;
const PROOF_REPLAY_TTL_MS = 120_000;
const LIMITER_LEASE_MS = 300_000;
const AUDIENCE = 'khala-channel-discovery' as const;

export type SessionRef = Readonly<{ harness: string; sessionId: string; generation: number }>;

export type SessionAuthorityResult =
  | Readonly<{ kind: 'verified'; principal: StableAgentPrincipal; currentGeneration: number }>
  | Readonly<{ kind: 'removed' | 'rebound' | 'unavailable' }>;

export interface DiscoverySessionAuthority {
  inspect(input: Readonly<{ ownerId: OwnerId; session: SessionRef }>): Promise<SessionAuthorityResult>;
}

export type DiscoveryAttemptReservation = Readonly<{
  kind: 'consent' | 'token';
  operationId: string;
  sourceBucket: string;
  subjectBucket: string;
  leaseMs: number;
}>;

export interface DiscoveryAttemptLimiter {
  reserve(input: DiscoveryAttemptReservation): Promise<
    Readonly<{ kind: 'reserved'; permit: Readonly<{ permitId: string }> }>
    | Readonly<{ kind: 'limited' | 'unavailable' }>
  >;
  finalize(input: Readonly<{
    permitId: string;
    operationId: string;
    disposition: 'failure' | 'release';
  }>): Promise<Readonly<{ kind: 'finalized' | 'released' | 'unavailable' }>>;
}

export type ChannelDiscoveryBootstrapDeps = Readonly<{
  origin: string;
  store: ControlStore;
  clock: TrustedClock;
  random: Random;
  authenticate(request: Request): Promise<Authentication>;
  sessionAuthority: DiscoverySessionAuthority;
  trustedSource(request: Request): Promise<Readonly<{ kind: 'trusted'; source: string }> | Readonly<{ kind: 'unavailable' }>>;
  limiter: DiscoveryAttemptLimiter;
}>;

export type DiscoveryCredentialRefusal =
  | 'credential_required' | 'invalid_credential' | 'scope_not_granted'
  | 'proof_required' | 'invalid_proof' | 'proof_key_mismatch' | 'proof_target_mismatch' | 'proof_token_mismatch' | 'proof_replayed';

export type DiscoveryCredentialAuthorization =
  | Readonly<{ kind: 'authorized'; action: DiscoveryScope; ownerId: OwnerId; requester: DiscoveryRequester }>
  | Readonly<{ kind: 'refused'; status: 401 | 403; code: DiscoveryCredentialRefusal }>
  | Readonly<{ kind: 'unavailable' }>;

export interface DiscoveryCredentials {
  authorize(request: Request, action: string): Promise<DiscoveryCredentialAuthorization>;
}

export type ChannelDiscoveryBootstrapHandlers = Readonly<{
  human: readonly RouteRegistration[];
  agent: readonly RouteRegistration[];
  credentials: DiscoveryCredentials;
}>;

type CodeRecord = {
  ownerId: string;
  principal: string;
  harness: string;
  sessionId: string;
  generation: number;
  origin: string;
  jkt: string;
  challenge: string;
  redirectUri: string;
  used: boolean;
};

type CredentialRecord = {
  ownerId: string;
  principal: string;
  harness: string;
  sessionId: string;
  generation: number;
  origin: string;
  audience: typeof AUDIENCE;
  scopes: DiscoveryScope[];
  jkt: string;
  publicKey: string;
  secretDigest: string;
  expiresAt: string;
};

type AuthorizeParams = Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
  origin: string;
  jkt: string;
  session: SessionRef;
}>;

const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[A-Za-z0-9._~-]{16,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;

export function createChannelDiscoveryBootstrapHandlers(deps: ChannelDiscoveryBootstrapDeps): ChannelDiscoveryBootstrapHandlers {
  const origin = new URL(deps.origin);
  if (origin.protocol !== 'https:' || origin.origin !== deps.origin) throw new Error('discovery bootstrap origin must be an exact https origin');
  const store = guardStore(deps.store);
  const tokenUrl = `${deps.origin}${TOKEN_PATH}`;

  async function inspect(ownerId: OwnerId, session: SessionRef): Promise<SessionAuthorityResult> {
    try {
      const result = await deps.sessionAuthority.inspect({ ownerId, session });
      if (result.kind === 'verified' && result.currentGeneration !== session.generation) return { kind: 'rebound' };
      return result;
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function consent(request: Request): Promise<Response> {
    const params = readAuthorizeParams(new URL(request.url).searchParams, deps.origin);
    if (!params) return json(400, 'invalid_request');
    const auth = await authenticate(deps, request);
    if (auth.kind === 'unavailable') return json(503, 'feature_unavailable');
    if (auth.kind === 'signed_out') return signIn(params);
    const authority = await inspect(auth.context.principal.ownerId, params.session);
    if (authority.kind === 'unavailable') return json(503, 'feature_unavailable');
    if (authority.kind !== 'verified') return json(403, 'access_denied');
    return consentPage(params, authority.principal, auth.context.csrfToken);
  }

  async function decide(request: Request): Promise<Response> {
    if (checkMutationOrigin(request, deps.origin) !== 'ok') return json(403, 'access_denied');
    const form = await readForm(request);
    const params = form && readAuthorizeParams(form, deps.origin, ['csrf_token', 'decision']);
    if (!form || !params) return json(400, 'invalid_request');
    const auth = await authenticate(deps, request);
    if (auth.kind === 'unavailable') return json(503, 'feature_unavailable');
    if (auth.kind === 'signed_out') return signIn(params);
    const csrf = form.getAll('csrf_token');
    if (csrf.length !== 1 || !csrfMatches(csrf[0]!, auth.context.csrfToken)) return json(403, 'access_denied');
    const decisions = form.getAll('decision');
    if (decisions.length !== 1 || (decisions[0] !== 'allow' && decisions[0] !== 'deny')) return json(400, 'invalid_request');
    if (decisions[0] === 'deny') return loopback(params.redirectUri, { state: params.state, error: 'access_denied' });

    const authority = await inspect(auth.context.principal.ownerId, params.session);
    if (authority.kind === 'unavailable') return json(503, 'feature_unavailable');
    if (authority.kind !== 'verified') return json(403, 'access_denied');
    const source = await trustedSource(deps, request);
    if (source === null) return json(503, 'feature_unavailable');
    const operationId = `consent-${randomToken(deps.random, 16)}`;
    const reservation = await reserve(deps, {
      kind: 'consent', operationId,
      sourceBucket: digestDiscoverySecret('limiter-source', source),
      subjectBucket: digestDiscoverySecret('limiter-subject', auth.context.principal.ownerId),
      leaseMs: LIMITER_LEASE_MS,
    });
    if (reservation === null || reservation.kind === 'unavailable') return json(503, 'feature_unavailable');
    if (reservation.kind === 'limited') return json(429, 'rate_limited');
    if (reservation.kind !== 'reserved') return json(503, 'feature_unavailable');

    const code = randomToken(deps.random, 32);
    const now = deps.clock();
    const value: CodeRecord = {
      ownerId: auth.context.principal.ownerId,
      principal: authority.principal,
      ...params.session,
      origin: params.origin,
      jkt: params.jkt,
      challenge: params.challenge,
      redirectUri: params.redirectUri,
      used: false,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: discoveryStoreKeys.code(code), expectedRevision: null, operationId,
      next: { value, expiresAt: new Date(now + CODE_TTL_MS).toISOString() },
    });
    const finalized = await finalize(deps, reservation.permit.permitId, operationId, written.kind === 'applied' ? 'release' : 'failure');
    if (finalized !== (written.kind === 'applied' ? 'released' : 'finalized')) return json(503, 'feature_unavailable');
    if (written.kind !== 'applied') return json(503, 'feature_unavailable');
    return loopback(params.redirectUri, { state: params.state, code });
  }

  async function token(request: Request): Promise<Response> {
    const body = await readBody(request);
    if (!body || (body.grant_type !== 'authorization_code' && body.grant_type !== 'refresh_token')) return json(400, 'invalid_request');
    const exact = body.grant_type === 'authorization_code'
      ? ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'harness', 'session_id', 'generation']
      : ['grant_type', 'harness', 'session_id', 'generation'];
    if (!hasExactKeys(body, exact)) return json(400, 'invalid_request');
    const session = readSession(body);
    if (!session) return json(400, 'invalid_request');
    return body.grant_type === 'authorization_code'
      ? exchange(request, body, session)
      : refresh(request, session);
  }

  async function exchange(request: Request, body: Record<string, unknown>, session: SessionRef): Promise<Response> {
    if (typeof body.code !== 'string' || !TOKEN.test(body.code) || typeof body.code_verifier !== 'string' || !VERIFIER.test(body.code_verifier)
      || typeof body.redirect_uri !== 'string') return json(400, 'invalid_request');
    const attempt = await tokenAttempt(request, body.code);
    if (attempt instanceof Response) return attempt;
    let success = false;
    try {
      const codeKey = discoveryStoreKeys.code(body.code);
      const read = await store.read<CodeRecord>(codeKey);
      if (read.kind === 'unavailable') return json(503, 'feature_unavailable');
      if (read.kind === 'absent' || read.record.value.used) return json(401, 'invalid_grant');
      const pending = read.record.value;
      const consumed = await settleWrite<JsonValue>(store, {
        key: codeKey, expectedRevision: read.record.revision, operationId: `consume-${randomToken(deps.random, 16)}`,
        next: { value: { ...pending, used: true }, expiresAt: read.record.expiresAt },
      });
      if (consumed.kind === 'conflict') return json(401, 'invalid_grant');
      if (consumed.kind !== 'applied') return json(503, 'feature_unavailable');
      const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
      if (!safeEqual(challenge, pending.challenge) || body.redirect_uri !== pending.redirectUri || !sameSession(pending, session)) {
        return json(401, 'invalid_grant');
      }
      const checked = await freshProof(request, { url: tokenUrl, jkt: pending.jkt });
      if (checked.kind !== 'valid') return proofResponse(checked);
      const authority = await inspect(pending.ownerId as OwnerId, session);
      if (authority.kind === 'unavailable') return json(503, 'feature_unavailable');
      if (authority.kind !== 'verified' || authority.principal !== pending.principal) return json(401, 'invalid_grant');
      const issued = await issueCredential({
        ownerId: pending.ownerId as OwnerId, principal: authority.principal, session, origin: pending.origin,
        jkt: pending.jkt, publicKey: checked.publicKey,
      });
      if (issued === null) return json(503, 'feature_unavailable');
      success = true;
      return jsonValue(200, { credential: issued });
    } finally {
      if (!await finishAttempt(attempt, success)) return json(503, 'feature_unavailable');
    }
  }

  async function refresh(request: Request, session: SessionRef): Promise<Response> {
    const raw = bearer(request);
    if (raw === null) return json(401, 'invalid_grant');
    const parsed = parseCredentialRef(raw);
    if (!parsed) return json(401, 'invalid_grant');
    const attempt = await tokenAttempt(request, parsed.slot);
    if (attempt instanceof Response) return attempt;
    let success = false;
    try {
      const slotKey = discoveryStoreKeys.slot(parsed.slot);
      const read = await store.read<CredentialRecord>(slotKey);
      if (read.kind === 'unavailable') return json(503, 'feature_unavailable');
      if (read.kind === 'absent' || !currentSecret(read.record.value, parsed.secret) || !sameSession(read.record.value, session)) {
        return json(401, 'invalid_grant');
      }
      const held = read.record.value;
      if (!validFixedMetadata(held, deps.origin) || deps.clock() >= Date.parse(held.expiresAt)) return json(401, 'invalid_grant');
      const checked = await freshProof(request, { url: tokenUrl, jkt: held.jkt, accessToken: raw });
      if (checked.kind !== 'valid') return proofResponse(checked);
      if (checked.publicKey !== held.publicKey) return json(401, 'invalid_proof');
      const authority = await inspect(held.ownerId as OwnerId, session);
      if (authority.kind === 'unavailable') return json(503, 'feature_unavailable');
      if (authority.kind !== 'verified' || authority.principal !== held.principal) return json(401, 'invalid_grant');

      const secret = randomToken(deps.random, 32);
      const expiresAt = new Date(deps.clock() + CREDENTIAL_TTL_MS).toISOString();
      const next: CredentialRecord = { ...held, secretDigest: digestDiscoverySecret('credential', secret), expiresAt };
      const rotated = await settleWrite<JsonValue>(store, {
        key: slotKey, expectedRevision: read.record.revision, operationId: `refresh-${randomToken(deps.random, 16)}`,
        next: { value: next, expiresAt },
      });
      if (rotated.kind === 'conflict') return json(409, 'refresh_conflict');
      if (rotated.kind !== 'applied') return json(503, 'feature_unavailable');
      success = true;
      return jsonValue(200, { credential: makeCredential(parsed.slot, secret, next) });
    } finally {
      if (!await finishAttempt(attempt, success)) return json(503, 'feature_unavailable');
    }
  }

  async function issueCredential(input: Readonly<{
    ownerId: OwnerId; principal: StableAgentPrincipal; session: SessionRef; origin: string; jkt: string; publicKey: string;
  }>): Promise<DiscoveryCredential | null> {
    const slot = randomToken(deps.random, 32);
    const secret = randomToken(deps.random, 32);
    const expiresAt = new Date(deps.clock() + CREDENTIAL_TTL_MS).toISOString();
    const record: CredentialRecord = {
      ownerId: input.ownerId, principal: input.principal, ...input.session, origin: input.origin, audience: AUDIENCE,
      scopes: [...CHANNEL_DISCOVERY_SCOPES], jkt: input.jkt, publicKey: input.publicKey,
      secretDigest: digestDiscoverySecret('credential', secret), expiresAt,
    };
    const written = await settleWrite<JsonValue>(store, {
      key: discoveryStoreKeys.slot(slot), expectedRevision: null, operationId: `issue-${randomToken(deps.random, 16)}`,
      next: { value: record, expiresAt },
    });
    return written.kind === 'applied' ? makeCredential(slot, secret, record) : null;
  }

  function makeCredential(slot: string, secret: string, record: CredentialRecord): DiscoveryCredential {
    return {
      v: 1,
      credentialRef: credentialRef(slot, secret),
      audience: AUDIENCE,
      requester: makeRequester(record),
      scopes: CHANNEL_DISCOVERY_SCOPES,
      expiresAt: record.expiresAt,
    };
  }

  function makeRequester(record: CredentialRecord): DiscoveryRequester {
    return {
      principal: record.principal as StableAgentPrincipal,
      origin: record.origin,
      proofKey: { algorithm: 'Ed25519', publicKey: record.publicKey, thumbprint: record.jkt },
      sessionGeneration: record.generation,
    };
  }

  type Attempt = Readonly<{ permitId: string; operationId: string }>;
  async function tokenAttempt(request: Request, subject: string): Promise<Attempt | Response> {
    const source = await trustedSource(deps, request);
    if (source === null) return json(503, 'feature_unavailable');
    const operationId = `token-${randomToken(deps.random, 16)}`;
    const held = await reserve(deps, {
      kind: 'token', operationId,
      sourceBucket: digestDiscoverySecret('limiter-source', source),
      subjectBucket: digestDiscoverySecret('limiter-subject', subject),
      leaseMs: LIMITER_LEASE_MS,
    });
    if (held === null || held.kind === 'unavailable') return json(503, 'feature_unavailable');
    if (held.kind === 'limited') return json(429, 'rate_limited');
    if (held.kind !== 'reserved') return json(503, 'feature_unavailable');
    return { permitId: held.permit.permitId, operationId };
  }

  async function finishAttempt(attempt: Attempt, success: boolean): Promise<boolean> {
    const finalized = await finalize(deps, attempt.permitId, attempt.operationId, success ? 'release' : 'failure');
    return finalized === (success ? 'released' : 'finalized');
  }

  type FreshProof = Extract<ProofCheck, { kind: 'valid' }>
    | Readonly<{ kind: 'failure'; code: 'invalid_proof' | 'proof_replayed' | 'unavailable' }>;

  async function freshProof(
    request: Request, expected: Readonly<{ url: string; jkt: string; accessToken?: string }>,
  ): Promise<FreshProof> {
    const now = deps.clock();
    const checked = checkProof(request.headers.get('dpop'), { method: request.method, ...expected, nowMs: now });
    if (checked.kind === 'invalid') return { kind: 'failure', code: 'invalid_proof' };
    const replay = await settleWrite<JsonValue>(store, {
      key: discoveryStoreKeys.proof(expected.jkt, checked.jti), expectedRevision: null,
      operationId: `proof-${randomToken(deps.random, 16)}`,
      next: { value: true, expiresAt: new Date(now + PROOF_REPLAY_TTL_MS).toISOString() },
    });
    if (replay.kind === 'conflict') return { kind: 'failure', code: 'proof_replayed' };
    if (replay.kind !== 'applied') return { kind: 'failure', code: 'unavailable' };
    return checked;
  }

  function proofResponse(failure: Extract<FreshProof, { kind: 'failure' }>): Response {
    return failure.code === 'unavailable' ? json(503, 'feature_unavailable') : json(401, 'invalid_proof');
  }

  const credentials: DiscoveryCredentials = {
    async authorize(request, action) {
      const raw = bearer(request);
      if (raw === null) return { kind: 'refused', status: 401, code: 'credential_required' };
      const parsed = parseCredentialRef(raw);
      if (!parsed) return refused('invalid_credential');
      const read = await store.read<CredentialRecord>(discoveryStoreKeys.slot(parsed.slot));
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind === 'absent' || !currentSecret(read.record.value, parsed.secret)) return refused('invalid_credential');
      const held = read.record.value;
      if (!validFixedMetadata(held, deps.origin) || deps.clock() >= Date.parse(held.expiresAt)) return refused('invalid_credential');
      if (!CHANNEL_DISCOVERY_SCOPES.includes(action as DiscoveryScope)) return { kind: 'refused', status: 403, code: 'scope_not_granted' };
      let target: URL;
      try {
        target = new URL(request.url);
      } catch {
        return refused('proof_target_mismatch');
      }
      if (target.origin !== deps.origin) return refused('proof_target_mismatch');
      const checked = await freshProof(request, {
        url: `${deps.origin}${target.pathname}${target.search}`, jkt: held.jkt, accessToken: raw,
      });
      if (checked.kind === 'failure') return checked.code === 'unavailable'
        ? { kind: 'unavailable' }
        : refused(checked.code);
      if (checked.publicKey !== held.publicKey) return refused('proof_key_mismatch');
      const authority = await inspect(held.ownerId as OwnerId, { harness: held.harness, sessionId: held.sessionId, generation: held.generation });
      if (authority.kind === 'unavailable') return { kind: 'unavailable' };
      if (authority.kind !== 'verified' || authority.principal !== held.principal) return refused('invalid_credential');
      return {
        kind: 'authorized', action: action as DiscoveryScope, ownerId: held.ownerId as OwnerId,
        requester: makeRequester(held),
      };
    },
  };

  function signIn(params: AuthorizeParams): Response {
    const returnPath = `${AUTHORIZE_PATH}?${authorizeQuery(params)}`;
    if (!isSameOriginReturnPath(returnPath)) return json(400, 'invalid_request');
    return redirect(`${deps.origin}${LOGIN_PATH}?return_to=${encodeURIComponent(returnPath)}`);
  }

  return {
    human: [{ path: AUTHORIZE_PATH, methods: ['GET', 'POST'], handle: request => request.method === 'POST' ? decide(request) : consent(request) }],
    agent: [{ path: TOKEN_PATH, methods: ['POST'], handle: token }],
    credentials,
  };
}

function readAuthorizeParams(query: URLSearchParams, expectedOrigin: string, extras: readonly string[] = []): AuthorizeParams | null {
  const expectedNames = new Set([
    'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'origin', 'harness', 'session_id', 'generation', 'proof_jkt', ...extras,
  ]);
  if ([...query.keys()].some(name => !expectedNames.has(name))) return null;
  const get = (name: string) => {
    const values = query.getAll(name);
    return values.length === 1 ? values[0]! : null;
  };
  const redirectUri = get('redirect_uri');
  const state = get('state');
  const challenge = get('code_challenge');
  const origin = get('origin');
  const harness = get('harness');
  const sessionId = get('session_id');
  const generation = get('generation');
  const jkt = get('proof_jkt');
  if (redirectUri === null || !isLoopbackRedirect(redirectUri) || state === null || !STATE.test(state)
    || challenge === null || !B64URL_43.test(challenge) || get('code_challenge_method') !== 'S256'
    || origin !== expectedOrigin || harness === null || !HARNESS.test(harness) || sessionId === null || !isText(sessionId)
    || generation === null || !/^(0|[1-9][0-9]{0,15})$/.test(generation) || !Number.isSafeInteger(Number(generation))
    || jkt === null || !B64URL_43.test(jkt)) return null;
  return { redirectUri, state, challenge, origin, jkt, session: { harness, sessionId, generation: Number(generation) } };
}

function authorizeQuery(params: AuthorizeParams): string {
  return new URLSearchParams({
    redirect_uri: params.redirectUri, state: params.state, code_challenge: params.challenge, code_challenge_method: 'S256',
    origin: params.origin, harness: params.session.harness, session_id: params.session.sessionId,
    generation: String(params.session.generation), proof_jkt: params.jkt,
  }).toString();
}

function readSession(body: Record<string, unknown>): SessionRef | null {
  if (typeof body.harness !== 'string' || !HARNESS.test(body.harness) || typeof body.session_id !== 'string' || !isText(body.session_id)
    || !Number.isSafeInteger(body.generation) || (body.generation as number) < 0) return null;
  return { harness: body.harness, sessionId: body.session_id, generation: body.generation as number };
}

function sameSession(record: Pick<CodeRecord, 'harness' | 'sessionId' | 'generation'>, session: SessionRef): boolean {
  return record.harness === session.harness && record.sessionId === session.sessionId && record.generation === session.generation;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validFixedMetadata(record: CredentialRecord, expectedOrigin: string): boolean {
  return record.origin === expectedOrigin && record.audience === AUDIENCE
    && record.scopes.length === CHANNEL_DISCOVERY_SCOPES.length
    && record.scopes.every((scope, index) => scope === CHANNEL_DISCOVERY_SCOPES[index]);
}

function currentSecret(record: CredentialRecord, secret: string): boolean {
  return safeEqual(record.secretDigest, digestDiscoverySecret('credential', secret));
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  if (!value) return null;
  const match = /^DPoP ([^ ]+)$/.exec(value);
  return match?.[1] ?? null;
}

async function authenticate(deps: ChannelDiscoveryBootstrapDeps, request: Request): Promise<Authentication> {
  try {
    return await deps.authenticate(request);
  } catch {
    return { kind: 'unavailable' };
  }
}

async function trustedSource(deps: ChannelDiscoveryBootstrapDeps, request: Request): Promise<string | null> {
  try {
    const source = await deps.trustedSource(request);
    return source.kind === 'trusted' && source.source.length > 0 ? source.source : null;
  } catch {
    return null;
  }
}

async function reserve(deps: ChannelDiscoveryBootstrapDeps, input: DiscoveryAttemptReservation) {
  try {
    return await deps.limiter.reserve(input);
  } catch {
    return null;
  }
}

async function finalize(
  deps: ChannelDiscoveryBootstrapDeps, permitId: string, operationId: string, disposition: 'failure' | 'release',
): Promise<'finalized' | 'released' | 'unavailable'> {
  try {
    return (await deps.limiter.finalize({ permitId, operationId, disposition })).kind;
  } catch {
    return 'unavailable';
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  try {
    const value: unknown = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

function consentPage(params: AuthorizeParams, stablePrincipal: StableAgentPrincipal, csrfToken: string): Response {
  const fields = [...new URLSearchParams(authorizeQuery(params)).entries(), ['csrf_token', csrfToken]]
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name!)}" value="${escapeHtml(value!)}">`).join('');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize channel discovery</title></head><body>
<h1>Authorize channel discovery?</h1>
<p>This lets this verified agent list channels, request access, and request channel creation. It does not join or create a channel.</p>
<dl><dt>Agent</dt><dd>${escapeHtml(stablePrincipal)}</dd><dt>Harness</dt><dd>${escapeHtml(params.session.harness)}</dd><dt>Session</dt><dd>${escapeHtml(params.session.sessionId)}</dd></dl>
<ul><li>List channels</li><li>Request access</li><li>Request channel creation</li></ul>
<form method="post" action="${AUTHORIZE_PATH}">${fields}<button type="submit" name="decision" value="allow">Authorize</button>
<button type="submit" name="decision" value="deny">Cancel</button></form></body></html>`;
  return new Response(body, { status: 200, headers: {
    ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  } });
}

export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== ''
    && url.username === '' && url.password === '' && url.hash === '' && url.search === '';
}

function isText(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 512 && !value.includes('\u0000');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function loopback(redirectUri: string, params: Record<string, string>): Response {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
  return redirect(target.href);
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, location } });
}

function json(status: number, error: string): Response {
  return jsonValue(status, { error });
}

function jsonValue(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json' } });
}

function refused(code: DiscoveryCredentialRefusal): DiscoveryCredentialAuthorization {
  return { kind: 'refused', status: 401, code };
}
