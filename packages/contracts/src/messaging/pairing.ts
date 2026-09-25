// Version-one pairing wire contracts. Code possession permits only a claim
// attempt; owner/channel disclosure and every authority-bearing transition live
// behind authenticated control handlers.

import {
  type Decoded, decodeWith, fail, identifier, literal, nullable, object, safeInteger, utcTimestamp, version,
} from './decode';
import { type DeviceId, type RoomId, readId } from './ids';

const CANONICAL_CODE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
const B64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_HANDLE = /^pair_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const PAIRING_FAILURE_CODES = {
  create: ['invalid_request', 'signed_out', 'forbidden', 'conflict', 'feature_unavailable', 'unavailable'],
  claim: ['invalid_request', 'claim_refused', 'rate_limited', 'invalid_proof', 'feature_unavailable', 'unavailable'],
  inspect: ['signed_out', 'forbidden', 'not_found', 'feature_unavailable', 'unavailable'],
  decide: [
    'invalid_request', 'signed_out', 'forbidden', 'stale_claim', 'decision_conflict', 'expired', 'feature_unavailable', 'unavailable',
  ],
  result: ['invalid_request', 'invalid_receipt', 'invalid_proof', 'feature_unavailable', 'unavailable'],
  redeem: ['invalid_grant', 'invalid_proof', 'unavailable'],
} as const;

export type PairingFailureRoute = keyof typeof PAIRING_FAILURE_CODES;
export type PairingFailureCode<Route extends PairingFailureRoute> = (typeof PAIRING_FAILURE_CODES)[Route][number];
export type PairingFailure<Route extends PairingFailureRoute> = Readonly<{
  v: 1;
  kind: 'rejected';
  code: PairingFailureCode<Route>;
}>;

export type PairingCreateRequest = Readonly<{
  v: 1;
  channelId: RoomId;
  /** Exact canonical origin: scheme, host, and optional non-default port only. */
  origin: string;
  descriptorId: string;
  operationId: string;
}>;

export type PairingCreateResult = Readonly<{
  v: 1;
  state: 'issued';
  code: string;
  requestHandle: string;
  expiresAt: string;
}>;

export type PairingClaimRequest = Readonly<{
  v: 1;
  /** Ten uppercase Crockford Base32 symbols in the one accepted grouping. */
  code: string;
  operationId: string;
  jkt: string;
  harness: string;
  sessionId: string;
  generation: number;
  deviceId: DeviceId;
  /** Canonical evidence digest supplied by the connector that inspected the session. */
  evidenceDigest: string;
}>;

export type PairingClaimResult = Readonly<{
  v: 1;
  state: 'pending';
  requestHandle: string;
  receipt: string;
}>;

export type PairingResultRequest = Readonly<{
  v: 1;
  requestHandle: string;
  /** Raw claim receipt; only its keyed digest may be retained. */
  receipt: string;
  operationId: string;
  /** Claimant key thumbprint, used to validate DPoP before any store lookup. */
  jkt: string;
}>;

export type PairingClaimProjection = Readonly<{
  jkt: string;
  harness: string;
  sessionId: string;
  generation: number;
  deviceId: DeviceId;
  evidenceDigest: string;
  fingerprint: string;
  /** Evidence is inspected by the connector, never attested by the control service. */
  verification: 'connector_verified';
}>;

export type PairingOwnerProjection = Readonly<{
  v: 1;
  requestHandle: string;
  state: 'issued' | 'claimed' | 'approved' | 'denied' | 'expired';
  channelId: RoomId;
  origin: string;
  descriptorId: string;
  createdAt: string;
  expiresAt: string;
  claim: PairingClaimProjection | null;
  decidedAt: string | null;
}>;

export type PairingOwnerResult = PairingOwnerProjection & Readonly<{ revision: string }>;
export type PairingDecisionResult = PairingOwnerResult;

export type PairingDecisionRequest = Readonly<{
  v: 1;
  requestHandle: string;
  revision: string;
  claimFingerprint: string;
  decision: 'approve' | 'deny';
  operationId: string;
}>;

export type PairingApprovalResult =
  | Readonly<{ v: 1; state: 'pending' }>
  | Readonly<{ v: 1; state: 'denied'; decidedAt: string }>
  | Readonly<{ v: 1; state: 'expired' }>
  | Readonly<{ v: 1; state: 'approved'; grant: string; expiresAt: string }>;

export type PairingGrantRedemptionRequest = Readonly<{
  v: 1;
  /** Raw 256-bit grant. Sender constraint is verified from the request proof. */
  grant: string;
  operationId: string;
}>;

export function decodePairingCreateRequest(input: unknown): Decoded<PairingCreateRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'channelId', 'origin', 'descriptorId', 'operationId']);
    return {
      v: version(r.field('v'), r.at('v')),
      channelId: readId<'RoomId'>(r.field('channelId'), r.at('channelId')),
      origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
      descriptorId: identifier(r.field('descriptorId'), r.at('descriptorId')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
    };
  });
}

export function decodePairingCreateResult(input: unknown): Decoded<PairingCreateResult> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'state', 'code', 'requestHandle', 'expiresAt']);
    return {
      v: version(r.field('v'), r.at('v')),
      state: literal(r.field('state'), r.at('state'), ['issued']),
      code: readCanonicalCode(r.field('code'), r.at('code')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
    };
  });
}

export function decodePairingClaimRequest(input: unknown): Decoded<PairingClaimRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'code', 'operationId', 'jkt', 'harness', 'sessionId', 'generation', 'deviceId', 'evidenceDigest']);
    return {
      v: version(r.field('v'), r.at('v')),
      code: readCanonicalCode(r.field('code'), r.at('code')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      jkt: readDigest(r.field('jkt'), r.at('jkt')),
      harness: identifier(r.field('harness'), r.at('harness')),
      sessionId: identifier(r.field('sessionId'), r.at('sessionId')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      deviceId: readId<'DeviceId'>(r.field('deviceId'), r.at('deviceId')),
      evidenceDigest: readDigest(r.field('evidenceDigest'), r.at('evidenceDigest')),
    };
  });
}

export function decodePairingClaimResult(input: unknown): Decoded<PairingClaimResult> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'state', 'requestHandle', 'receipt']);
    return {
      v: version(r.field('v'), r.at('v')),
      state: literal(r.field('state'), r.at('state'), ['pending']),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      receipt: readDigest(r.field('receipt'), r.at('receipt')),
    };
  });
}

export function decodePairingResultRequest(input: unknown): Decoded<PairingResultRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'requestHandle', 'receipt', 'operationId', 'jkt']);
    return {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      receipt: readDigest(r.field('receipt'), r.at('receipt')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      jkt: readDigest(r.field('jkt'), r.at('jkt')),
    };
  });
}

export function decodePairingOwnerProjection(input: unknown): Decoded<PairingOwnerProjection> {
  return decodeWith(() => readOwnerProjection(input, '', OWNER_PROJECTION_FIELDS));
}

export function decodePairingOwnerResult(input: unknown): Decoded<PairingOwnerResult> {
  return decodeWith(() => {
    const projection = readOwnerProjection(input, '', OWNER_RESULT_FIELDS);
    const r = object(input, '', OWNER_RESULT_FIELDS);
    return { ...projection, revision: identifier(r.field('revision'), r.at('revision')) };
  });
}

export function decodePairingDecisionResult(input: unknown): Decoded<PairingDecisionResult> {
  return decodePairingOwnerResult(input);
}

export function decodePairingDecisionRequest(input: unknown): Decoded<PairingDecisionRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'requestHandle', 'revision', 'claimFingerprint', 'decision', 'operationId']);
    return {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      revision: identifier(r.field('revision'), r.at('revision')),
      claimFingerprint: readDigest(r.field('claimFingerprint'), r.at('claimFingerprint')),
      decision: literal(r.field('decision'), r.at('decision'), ['approve', 'deny']),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
    };
  });
}

export function decodePairingApprovalResult(input: unknown): Decoded<PairingApprovalResult> {
  return decodeWith(() => {
    const rawState = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).state
      : undefined;
    if (rawState === 'pending' || rawState === 'expired') {
      const r = object(input, '', ['v', 'state']);
      return { v: version(r.field('v'), r.at('v')), state: literal(r.field('state'), r.at('state'), [rawState]) };
    }
    if (rawState === 'denied') {
      const r = object(input, '', ['v', 'state', 'decidedAt']);
      return {
        v: version(r.field('v'), r.at('v')),
        state: literal(r.field('state'), r.at('state'), ['denied']),
        decidedAt: utcTimestamp(r.field('decidedAt'), r.at('decidedAt')),
      };
    }
    if (rawState === 'approved') {
      const r = object(input, '', ['v', 'state', 'grant', 'expiresAt']);
      return {
        v: version(r.field('v'), r.at('v')),
        state: literal(r.field('state'), r.at('state'), ['approved']),
        grant: readDigest(r.field('grant'), r.at('grant')),
        expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
      };
    }
    const r = object(input, '', ['v', 'state']);
    version(r.field('v'), r.at('v'));
    return { v: 1, state: literal(r.field('state'), r.at('state'), ['pending', 'expired']) };
  });
}

export function decodePairingGrantRedemptionRequest(input: unknown): Decoded<PairingGrantRedemptionRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'grant', 'operationId']);
    return {
      v: version(r.field('v'), r.at('v')),
      grant: readDigest(r.field('grant'), r.at('grant')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
    };
  });
}

/** Strict decoder for a route's closed, versioned failure vocabulary. */
export function decodePairingFailure<Route extends PairingFailureRoute>(route: Route, input: unknown): Decoded<PairingFailure<Route>> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'kind', 'code']);
    return {
      v: version(r.field('v'), r.at('v')),
      kind: literal(r.field('kind'), r.at('kind'), ['rejected']),
      code: literal(r.field('code'), r.at('code'), PAIRING_FAILURE_CODES[route]),
    };
  });
}

export function readCanonicalCode(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!CANONICAL_CODE.test(input)) fail(path, 'invalid_value');
  return input;
}

export function readCanonicalOrigin(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail(path, 'invalid_value');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || input !== parsed.origin
    || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)))) fail(path, 'invalid_value');
  return input;
}

function readClaimProjection(input: unknown, path: string): PairingClaimProjection {
  const r = object(input, path, ['jkt', 'harness', 'sessionId', 'generation', 'deviceId', 'evidenceDigest', 'fingerprint', 'verification']);
  return {
    jkt: readDigest(r.field('jkt'), r.at('jkt')),
    harness: identifier(r.field('harness'), r.at('harness')),
    sessionId: identifier(r.field('sessionId'), r.at('sessionId')),
    generation: safeInteger(r.field('generation'), r.at('generation')),
    deviceId: readId<'DeviceId'>(r.field('deviceId'), r.at('deviceId')),
    evidenceDigest: readDigest(r.field('evidenceDigest'), r.at('evidenceDigest')),
    fingerprint: readDigest(r.field('fingerprint'), r.at('fingerprint')),
    verification: literal(r.field('verification'), r.at('verification'), ['connector_verified']),
  };
}

const OWNER_PROJECTION_FIELDS = [
  'v', 'requestHandle', 'state', 'channelId', 'origin', 'descriptorId', 'createdAt', 'expiresAt', 'claim', 'decidedAt',
] as const;
const OWNER_RESULT_FIELDS = [...OWNER_PROJECTION_FIELDS, 'revision'] as const;

function readOwnerProjection(
  input: unknown,
  path: string,
  fields: readonly string[],
): PairingOwnerProjection {
  const r = object(input, path, fields);
  const value: PairingOwnerProjection = {
    v: version(r.field('v'), r.at('v')),
    requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
    state: literal(r.field('state'), r.at('state'), ['issued', 'claimed', 'approved', 'denied', 'expired']),
    channelId: readId<'RoomId'>(r.field('channelId'), r.at('channelId')),
    origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
    descriptorId: identifier(r.field('descriptorId'), r.at('descriptorId')),
    createdAt: utcTimestamp(r.field('createdAt'), r.at('createdAt')),
    expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
    claim: nullable(r.field('claim'), claim => readClaimProjection(claim, r.at('claim'))),
    decidedAt: nullable(r.field('decidedAt'), decidedAt => utcTimestamp(decidedAt, r.at('decidedAt'))),
  };
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) fail(r.at('expiresAt'), 'invalid_value');
  if (value.decidedAt !== null
    && (Date.parse(value.decidedAt) < Date.parse(value.createdAt) || Date.parse(value.decidedAt) >= Date.parse(value.expiresAt))) {
    fail(r.at('decidedAt'), 'invalid_value');
  }
  const needsClaim = value.state === 'claimed' || value.state === 'approved' || value.state === 'denied';
  if ((value.state === 'issued' && value.claim !== null) || (needsClaim && value.claim === null)) fail(r.at('claim'), 'mismatch');
  const needsDecision = value.state === 'approved' || value.state === 'denied';
  if (needsDecision !== (value.decidedAt !== null)) fail(r.at('decidedAt'), 'mismatch');
  return value;
}

function readDigest(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!B64URL_256.test(input)) fail(path, 'invalid_value');
  return input;
}

function readRequestHandle(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!REQUEST_HANDLE.test(input)) fail(path, 'invalid_value');
  return input;
}
