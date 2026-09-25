import {
  decodePairingClaimRequest,
  decodePairingCreateRequest,
  decodePairingDecisionRequest,
  decodePairingResultRequest,
  type OwnerId,
  type RoomId,
  type TrustedClock,
} from '@khala/contracts/messaging/index';
import { PROOF_MAX_AGE_S, PROOF_MAX_SKEW_S, checkProof } from '../agent-bootstrap/proof';
import type { AuthService } from '../auth';
import type { RouteRegistration } from '../runtime/handler';
import { PAIRING_ATTEMPT_LEASE_MS, type PairingAttemptLimiter, type PairingPolicy } from './policy';
import type { PairingGrantPort, PairingStore } from './store';

export const HUMAN_PAIRING_REQUEST_PATH = '/api/human/pairing/request';
export const HUMAN_PAIRING_DECISION_PATH = '/api/human/pairing/decision';
export const AGENT_PAIRING_CLAIM_PATH = '/api/agent/pairing/claim';
export const AGENT_PAIRING_RESULT_PATH = '/api/agent/pairing/result';

const REQUEST_HANDLE = /^pair_[A-Za-z0-9_-]{43}$/;
const REPLAY_TTL_MS = (PROOF_MAX_AGE_S + PROOF_MAX_SKEW_S) * 1_000;

export type PairingTargetAuthorization =
  | Readonly<{ kind: 'allowed'; origin: string; descriptorId: string }>
  | Readonly<{ kind: 'forbidden' }>
  | Readonly<{ kind: 'unavailable' }>;

export type TrustedPairingSource =
  | Readonly<{ kind: 'trusted'; source: string }>
  | Readonly<{ kind: 'unavailable' }>;

export type PairingHandlerDependencies = Readonly<{
  /** Exact public origin used for proof target comparison. */
  origin: string;
  clock: TrustedClock;
  store: PairingStore;
  policy: Pick<PairingPolicy, 'attemptBuckets'>;
  limiter: PairingAttemptLimiter;
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  trustedSource(request: Request): Promise<TrustedPairingSource>;
  authorizeTarget(input: Readonly<{ ownerId: OwnerId; channelId: RoomId }>): Promise<PairingTargetAuthorization>;
}>;

export type PairingHandlers = Readonly<{
  human: readonly RouteRegistration[];
  agent: readonly RouteRegistration[];
  /** Internal-only grant redemption boundary; it is deliberately not registered as HTTP. */
  grantPort: PairingGrantPort;
}>;

export function createPairingHandlers(deps: PairingHandlerDependencies): PairingHandlers {
  const configured = new URL(deps.origin);
  if (configured.protocol !== 'https:' || configured.origin !== deps.origin) {
    throw new TypeError('pairing origin must be an exact https origin');
  }
  const claimUrl = `${deps.origin}${AGENT_PAIRING_CLAIM_PATH}`;
  const resultUrl = `${deps.origin}${AGENT_PAIRING_RESULT_PATH}`;

  async function create(request: Request): Promise<Response> {
    const authorization = await mutationAuthorization(deps, request);
    if (authorization instanceof Response) return authorization;
    const body = decodePairingCreateRequest(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const target = await safeCall(() => deps.authorizeTarget({
      ownerId: authorization.principal.ownerId,
      channelId: body.value.channelId,
    }));
    if (target === null || target.kind === 'unavailable') return rejected(503, 'unavailable');
    if (target.kind !== 'allowed'
      || target.origin !== body.value.origin
      || target.descriptorId !== body.value.descriptorId) return rejected(403, 'forbidden');
    const outcome = await safeCall(() => deps.store.create({
      ownerId: authorization.principal.ownerId,
      channelId: body.value.channelId,
      origin: target.origin,
      descriptorId: target.descriptorId,
      operationId: body.value.operationId,
    }));
    if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
    if (outcome.kind === 'conflict') return rejected(409, 'conflict');
    return json(201, {
      v: 1, state: 'issued', code: outcome.code, requestHandle: outcome.requestHandle, expiresAt: outcome.expiresAt,
    });
  }

  async function inspect(request: Request): Promise<Response> {
    const authentication = await requestAuthentication(deps, request);
    if (authentication instanceof Response) return authentication;
    const url = new URL(request.url);
    const values = url.searchParams.getAll('request_id');
    if ([...url.searchParams.keys()].some(key => key !== 'request_id') || values.length !== 1 || !REQUEST_HANDLE.test(values[0]!)) {
      return rejected(404, 'not_found');
    }
    const outcome = await safeCall(() => deps.store.inspect({
      ownerId: authentication.principal.ownerId,
      requestHandle: values[0]!,
    }));
    if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
    if (outcome.kind === 'forbidden') return rejected(403, 'forbidden');
    if (outcome.kind === 'not_found') return rejected(404, 'not_found');
    return json(200, { ...outcome.projection, revision: outcome.revision });
  }

  async function decide(request: Request): Promise<Response> {
    const authorization = await mutationAuthorization(deps, request);
    if (authorization instanceof Response) return authorization;
    const body = decodePairingDecisionRequest(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const outcome = await safeCall(() => deps.store.decide({
      ownerId: authorization.principal.ownerId,
      requestHandle: body.value.requestHandle,
      revision: body.value.revision,
      claimFingerprint: body.value.claimFingerprint,
      decision: body.value.decision,
      operationId: body.value.operationId,
    }));
    if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
    if (outcome.kind === 'forbidden' || outcome.kind === 'not_found') return rejected(403, 'forbidden');
    if (outcome.kind === 'stale') return rejected(409, 'stale_claim');
    if (outcome.kind === 'conflict') return rejected(409, 'decision_conflict');
    if (outcome.kind === 'expired') return rejected(409, 'expired');
    return json(200, { ...outcome.projection, revision: outcome.revision });
  }

  async function claim(request: Request): Promise<Response> {
    const body = decodePairingClaimRequest(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const proof = checkProof(request.headers.get('dpop'), {
      method: 'POST', url: claimUrl, jkt: body.value.jkt, nowMs: deps.clock(),
    });
    if (proof.kind !== 'valid') return rejected(401, 'invalid_proof');
    const replay = await claimReplay(deps, body.value.jkt, proof.jti);
    if (replay instanceof Response) return replay;

    const source = await safeCall(() => deps.trustedSource(request));
    if (source === null || source.kind !== 'trusted' || source.source.length === 0) return rejected(503, 'unavailable');
    let buckets: ReturnType<PairingHandlerDependencies['policy']['attemptBuckets']>;
    try {
      buckets = deps.policy.attemptBuckets({
        trustedSource: source.source, code: body.value.code, operationId: body.value.operationId,
      });
    } catch {
      return rejected(503, 'unavailable');
    }
    const reservation = await safeCall(() => deps.limiter.reserve({
      operationId: body.value.operationId,
      sourceBucket: buckets.sourceBucket,
      codeBucket: buckets.codeBucket,
      leaseMs: PAIRING_ATTEMPT_LEASE_MS,
    }));
    if (reservation === null || reservation.kind === 'unavailable') return rejected(503, 'unavailable');
    if (reservation.kind === 'limited') return rejected(429, 'rate_limited');

    const outcome = await safeCall(() => deps.store.claim({
      code: body.value.code,
      operationId: body.value.operationId,
      jkt: body.value.jkt,
      harness: body.value.harness,
      sessionId: body.value.sessionId,
      generation: body.value.generation,
      deviceId: body.value.deviceId,
      evidenceDigest: body.value.evidenceDigest,
    }));
    const disposition = outcome?.kind === 'claimed' ? 'release' : 'failure';
    const finalized = await safeCall(() => deps.limiter.finalize({
      permitId: reservation.permit.permitId,
      operationId: body.value.operationId,
      disposition,
    }));
    if (finalized === null || finalized.kind === 'unavailable') return rejected(503, 'unavailable');
    const expectedFinalization = disposition === 'release' ? 'released' : 'finalized';
    if (finalized.kind !== expectedFinalization) return rejected(503, 'unavailable');
    if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
    if (outcome.kind === 'refused') return rejected(400, 'claim_refused');
    return json(200, { v: 1, state: 'pending', requestHandle: outcome.requestHandle, receipt: outcome.receipt });
  }

  async function result(request: Request): Promise<Response> {
    const body = decodePairingResultRequest(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const proof = checkProof(request.headers.get('dpop'), {
      method: 'POST', url: resultUrl, jkt: body.value.jkt, nowMs: deps.clock(),
    });
    if (proof.kind !== 'valid') return rejected(401, 'invalid_proof');
    const replay = await claimReplay(deps, body.value.jkt, proof.jti);
    if (replay instanceof Response) return replay;
    const outcome = await safeCall(() => deps.store.result(body.value));
    if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
    if (outcome.kind === 'invalid') return rejected(400, 'invalid_receipt');
    return json(200, outcome.value);
  }

  const human = Object.freeze([
    Object.freeze<RouteRegistration>({
      path: HUMAN_PAIRING_REQUEST_PATH,
      methods: Object.freeze(['POST', 'GET']),
      handle: request => request.method === 'GET' ? inspect(request) : create(request),
    }),
    Object.freeze<RouteRegistration>({
      path: HUMAN_PAIRING_DECISION_PATH,
      methods: Object.freeze(['POST']),
      handle: decide,
    }),
  ]);
  const agent = Object.freeze([
    Object.freeze<RouteRegistration>({ path: AGENT_PAIRING_CLAIM_PATH, methods: Object.freeze(['POST']), handle: claim }),
    Object.freeze<RouteRegistration>({ path: AGENT_PAIRING_RESULT_PATH, methods: Object.freeze(['POST']), handle: result }),
  ]);
  return Object.freeze({ human, agent, grantPort: deps.store.grantPort });
}

async function claimReplay(deps: PairingHandlerDependencies, jkt: string, jti: string): Promise<true | Response> {
  const now = deps.clock();
  const outcome = await safeCall(() => deps.store.claimProofReplay({
    jkt, jti, expiresAt: new Date(now + REPLAY_TTL_MS).toISOString(),
  }));
  if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
  if (outcome.kind === 'replayed') return rejected(401, 'invalid_proof');
  return true;
}

async function mutationAuthorization(deps: PairingHandlerDependencies, request: Request) {
  const outcome = await safeCall(() => deps.auth.requireHumanMutation(request));
  if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
  if (outcome.kind === 'rejected') {
    return outcome.code === 'signed_out' ? rejected(401, 'signed_out') : rejected(403, 'forbidden');
  }
  return outcome.context;
}

async function requestAuthentication(deps: PairingHandlerDependencies, request: Request) {
  const outcome = await safeCall(() => deps.auth.authenticateRequest(request));
  if (outcome === null || outcome.kind === 'unavailable') return rejected(503, 'unavailable');
  if (outcome.kind === 'signed_out') return rejected(401, 'signed_out');
  return outcome.context;
}

async function readJson(request: Request): Promise<unknown> {
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return undefined;
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function safeCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

function rejected(status: number, code: string): Response {
  return json(status, { v: 1, kind: 'rejected', code });
}

const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}
