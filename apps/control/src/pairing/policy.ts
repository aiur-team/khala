// Security policy for pairing-code identifiers and attempt limiting. This file
// defines the provider boundary but deliberately does not pretend an in-memory
// limiter can satisfy the required multi-instance atomicity.

import { createHmac } from 'node:crypto';
import {
  readCanonicalCode,
  readCanonicalOrigin,
  type DeviceId,
  type OwnerId,
  type RoomId,
} from '@khala/contracts/messaging/index';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DOMAIN = 'khala.pairing.v1';

export const MAX_PAIRING_KEY_COUNT = 4;
export const PAIRING_REQUEST_LIFETIME_MS = 5 * 60_000;
export const PAIRING_GRANT_LIFETIME_MS = 60_000;
export const PAIRING_ATTEMPT_LIMIT = 5;
export const PAIRING_ATTEMPT_LEASE_MS = 5 * 60_000;

type Purpose =
  | 'create-code'
  | 'create-tuple-fingerprint'
  | 'create-operation-handle'
  | 'request-handle'
  | 'code-digest'
  | 'claim-fingerprint'
  | 'claim-receipt'
  | 'claim-receipt-digest'
  | 'grant'
  | 'grant-digest'
  | 'proof-replay-handle'
  | 'rate-source-bucket'
  | 'rate-code-bucket';

export type PairingKeyring = Readonly<{
  v: 1;
  activeKeyId: string;
  /**
   * Active/newest key first, followed by retained keys newest-to-oldest.
   * The oldest key must remain until every replay and limiter window derived
   * from it has drained; only then may rotation retire it and cut the stable
   * replay/limiter namespace over to the next-oldest key.
   */
  keys: readonly Readonly<{ id: string; key: Uint8Array }>[];
}>;

export type PairingCreateTuple = Readonly<{
  ownerId: OwnerId;
  channelId: RoomId;
  origin: string;
  descriptorId: string;
  operationId: string;
}>;

export type PairingClaimEvidence = Readonly<{
  ownerId: OwnerId;
  channelId: RoomId;
  origin: string;
  descriptorId: string;
  jkt: string;
  harness: string;
  sessionId: string;
  generation: number;
  deviceId: DeviceId;
  evidenceDigest: string;
}>;

export type PairingCodeCandidate = Readonly<{
  keyId: string;
  requestHandle: string;
  codeDigest: string;
}>;

export type PairingCreateArtifacts = PairingCodeCandidate & Readonly<{
  code: string;
  /** Stable for one owner/operation, enabling changed-tuple conflict detection. */
  operationHandle: string;
  tupleFingerprint: string;
}>;

export type PairingSecret = Readonly<{ value: string; digest: string; keyId: string }>;
export type PairingDigestCandidate = Readonly<{ keyId: string; digest: string }>;

export type PairingAttemptReserveInput = Readonly<{
  /** Stable claim-attempt operation; retries must reconcile the same permit. */
  operationId: string;
  /** Derived only from trusted platform/network metadata. */
  sourceBucket: string;
  /** Keyed canonical-code handle, independent of the client operation. */
  codeBucket: string;
  /** The only supported lease; providers must not extend it. */
  leaseMs: typeof PAIRING_ATTEMPT_LEASE_MS;
}>;

export type PairingAttemptPermit = Readonly<{
  permitId: string;
  leaseExpiresAt: string;
}>;

export type PairingAttemptReserveResult =
  | Readonly<{ kind: 'reserved'; permit: PairingAttemptPermit }>
  | Readonly<{ kind: 'limited' }>
  | Readonly<{ kind: 'unavailable' }>;

export type PairingAttemptFinalizeInput = Readonly<{
  permitId: string;
  operationId: string;
  /** Invalid/different claims consume a failure; a winner or winning retry releases it. */
  disposition: 'failure' | 'release';
}>;

export type PairingAttemptFinalizeResult =
  | Readonly<{ kind: 'finalized' }>
  | Readonly<{ kind: 'released' }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * A production implementation must reserve the source and code buckets in one
 * atomic operation. A reservation counts against both five-attempt budgets until
 * idempotently finalized/released or its at-most-five-minute lease expires.
 * `unavailable` is fail-closed at either step.
 */
export interface PairingAttemptLimiter {
  reserve(input: PairingAttemptReserveInput): Promise<PairingAttemptReserveResult>;
  finalize(input: PairingAttemptFinalizeInput): Promise<PairingAttemptFinalizeResult>;
}

export type PairingPolicy = Readonly<{
  deriveCreate(tuple: PairingCreateTuple): PairingCreateArtifacts;
  /** Active first, then retained keys, so a create retry can recover across rotation. */
  deriveCreateCandidates(tuple: PairingCreateTuple): readonly PairingCreateArtifacts[];
  locateCode(code: string): readonly PairingCodeCandidate[];
  claimFingerprint(evidence: PairingClaimEvidence, keyId?: string): string;
  deriveClaimReceipt(input: Readonly<{ operationId: string; fingerprint: string; keyId?: string }>): PairingSecret;
  digestClaimReceipt(receipt: string, keyId?: string): string;
  deriveGrant(input: Readonly<{ requestHandle: string; approvedRevision: string; fingerprint: string; keyId?: string }>): PairingSecret;
  digestGrant(grant: string, keyId?: string): string;
  /** Active first, then retained keys, for raw-grant lookup during rotation. */
  digestGrantCandidates(grant: string): readonly PairingDigestCandidate[];
  replayHandle(input: Readonly<{ jkt: string; jti: string }>, keyId?: string): string;
  sourceBucket(trustedSource: string): string;
  codeBucket(code: string): string;
  attemptBuckets(input: Readonly<{ trustedSource: string; code: string; operationId: string }>): Readonly<{
    sourceBucket: string;
    codeBucket: string;
  }>;
}>;

export function createPairingPolicy(input: PairingKeyring): PairingPolicy {
  const keys = validateKeyring(input);
  const active = keys.get(input.activeKeyId)!;
  const namespace = keys.get(input.keys.at(-1)!.id)!;
  const orderedKeys = [
    [input.activeKeyId, active] as const,
    ...[...keys].filter(([id]) => id !== input.activeKeyId),
  ];

  const selected = (keyId?: string): Readonly<{ id: string; key: Uint8Array }> => {
    const id = keyId ?? input.activeKeyId;
    const key = keys.get(id);
    if (!key) throw new TypeError(`pairing key ${id} is not live`);
    return { id, key };
  };
  const mac = (purpose: Purpose, fields: readonly CanonicalField[], key = active) => hmac(key, purpose, canonical(fields));
  const digest = (purpose: Purpose, fields: readonly CanonicalField[], key = active) => mac(purpose, fields, key).toString('base64url');

  const candidate = (code: string, keyId: string, key: Uint8Array): PairingCodeCandidate => ({
    keyId,
    requestHandle: `pair_${digest('request-handle', [['code', code]], key)}`,
    codeDigest: digest('code-digest', [['code', code]], key),
  });
  const createArtifacts = (tuple: PairingCreateTuple, keyId: string, key: Uint8Array): PairingCreateArtifacts => {
    const tupleFields = createFields(tuple);
    const code = encodeCode(mac('create-code', tupleFields, key));
    return {
      ...candidate(code, keyId, key),
      code,
      operationHandle: `pair_op_${digest('create-operation-handle', [
        ['ownerId', tuple.ownerId], ['operationId', tuple.operationId],
      ], key)}`,
      tupleFingerprint: digest('create-tuple-fingerprint', tupleFields, key),
    };
  };

  return {
    deriveCreate(tuple) {
      assertCreateTuple(tuple);
      return createArtifacts(tuple, input.activeKeyId, active);
    },
    deriveCreateCandidates(tuple) {
      assertCreateTuple(tuple);
      return orderedKeys.map(([keyId, key]) => createArtifacts(tuple, keyId, key));
    },
    locateCode(code) {
      assertCanonicalCode(code);
      return orderedKeys.map(([keyId, key]) => candidate(code, keyId, key));
    },
    claimFingerprint(evidence, keyId) {
      assertClaimEvidence(evidence);
      const { key } = selected(keyId);
      return digest('claim-fingerprint', claimFields(evidence), key);
    },
    deriveClaimReceipt(receiptInput) {
      assertText(receiptInput.operationId, 'claim operation');
      assertText(receiptInput.fingerprint, 'claim fingerprint');
      const { id, key } = selected(receiptInput.keyId);
      const fields: readonly CanonicalField[] = [
        ['operationId', receiptInput.operationId], ['fingerprint', receiptInput.fingerprint],
      ];
      const value = digest('claim-receipt', fields, key);
      return { value, digest: digestForSecret('claim-receipt-digest', value, key), keyId: id };
    },
    digestClaimReceipt(receipt, keyId) {
      assertText(receipt, 'claim receipt');
      return digestForSecret('claim-receipt-digest', receipt, selected(keyId).key);
    },
    deriveGrant(grantInput) {
      assertText(grantInput.requestHandle, 'request handle');
      assertText(grantInput.approvedRevision, 'approved revision');
      assertText(grantInput.fingerprint, 'claim fingerprint');
      const { id, key } = selected(grantInput.keyId);
      const value = digest('grant', [
        ['requestHandle', grantInput.requestHandle],
        ['approvedRevision', grantInput.approvedRevision],
        ['fingerprint', grantInput.fingerprint],
      ], key);
      return { value, digest: digestForSecret('grant-digest', value, key), keyId: id };
    },
    digestGrant(grant, keyId) {
      assertText(grant, 'grant');
      return digestForSecret('grant-digest', grant, selected(keyId).key);
    },
    digestGrantCandidates(grant) {
      assertText(grant, 'grant');
      return orderedKeys.map(([keyId, key]) => ({ keyId, digest: digestForSecret('grant-digest', grant, key) }));
    },
    replayHandle(replay, keyId) {
      assertText(replay.jkt, 'proof thumbprint');
      assertText(replay.jti, 'proof replay identifier');
      return digest('proof-replay-handle', [['jkt', replay.jkt], ['jti', replay.jti]], keyId ? selected(keyId).key : namespace);
    },
    sourceBucket(trustedSource) {
      assertText(trustedSource, 'trusted source');
      return `pair_source_${digest('rate-source-bucket', [['trustedSource', trustedSource]], namespace)}`;
    },
    codeBucket(code) {
      assertCanonicalCode(code);
      return `pair_code_${digest('rate-code-bucket', [['code', code]], namespace)}`;
    },
    attemptBuckets(attempt) {
      // operationId is validated for stable retry identity but intentionally does
      // not participate in either bucket derivation.
      assertText(attempt.operationId, 'claim operation');
      assertText(attempt.trustedSource, 'trusted source');
      assertCanonicalCode(attempt.code);
      return {
        sourceBucket: `pair_source_${digest('rate-source-bucket', [['trustedSource', attempt.trustedSource]], namespace)}`,
        codeBucket: `pair_code_${digest('rate-code-bucket', [['code', attempt.code]], namespace)}`,
      };
    },
  };

  function digestForSecret(purpose: 'claim-receipt-digest' | 'grant-digest', value: string, key: Uint8Array): string {
    return digest(purpose, [['secret', value]], key);
  }
}

type CanonicalField = readonly [name: string, value: string | number];

function validateKeyring(input: PairingKeyring): Map<string, Uint8Array> {
  if (input.v !== 1) throw new TypeError('pairing keyring version must be 1');
  if (!KEY_ID.test(input.activeKeyId)) throw new TypeError('pairing active key id is invalid');
  if (!Array.isArray(input.keys) || input.keys.length === 0 || input.keys.length > MAX_PAIRING_KEY_COUNT) {
    throw new TypeError(`pairing keyring must contain 1-${MAX_PAIRING_KEY_COUNT} keys`);
  }
  const keys = new Map<string, Uint8Array>();
  for (const entry of input.keys) {
    if (!KEY_ID.test(entry.id)) throw new TypeError('pairing key id is invalid');
    if (keys.has(entry.id)) throw new TypeError('pairing key ids must be unique');
    if (!(entry.key instanceof Uint8Array) || entry.key.byteLength < 32) {
      throw new TypeError('pairing keys must contain at least 32 bytes');
    }
    keys.set(entry.id, Uint8Array.from(entry.key));
  }
  if (!keys.has(input.activeKeyId)) throw new TypeError('pairing active key must be present');
  if (input.keys[0]!.id !== input.activeKeyId) {
    throw new TypeError('pairing active key must be first in newest-to-oldest key order');
  }
  return keys;
}

function hmac(key: Uint8Array, purpose: Purpose, bytes: Uint8Array): Buffer {
  return createHmac('sha256', key).update(`${DOMAIN}\0${purpose}\0`).update(bytes).digest();
}

/** Stable, injective length-prefix encoding; never depends on JSON key order. */
function canonical(fields: readonly CanonicalField[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const [name, raw] of fields) {
    const value = Buffer.from(String(raw), 'utf8');
    const label = Buffer.from(name, 'utf8');
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(label.byteLength, 0);
    lengths.writeUInt32BE(value.byteLength, 4);
    parts.push(lengths, label, value);
  }
  return Buffer.concat(parts);
}

function encodeCode(bytes: Uint8Array): string {
  // Ten five-bit symbols consume the high 50 bits of the PRF output directly;
  // no modulo reduction means no alphabet bias.
  let bits = 0n;
  for (let index = 0; index < 7; index += 1) bits = (bits << 8n) | BigInt(bytes[index]!);
  bits >>= 6n;
  let symbols = '';
  for (let index = 9; index >= 0; index -= 1) symbols += CROCKFORD[Number((bits >> BigInt(index * 5)) & 31n)];
  return `${symbols.slice(0, 5)}-${symbols.slice(5)}`;
}

function createFields(tuple: PairingCreateTuple): readonly CanonicalField[] {
  return [
    ['ownerId', tuple.ownerId],
    ['channelId', tuple.channelId],
    ['origin', tuple.origin],
    ['descriptorId', tuple.descriptorId],
    ['operationId', tuple.operationId],
  ];
}

function claimFields(evidence: PairingClaimEvidence): readonly CanonicalField[] {
  return [
    ['ownerId', evidence.ownerId],
    ['channelId', evidence.channelId],
    ['origin', evidence.origin],
    ['descriptorId', evidence.descriptorId],
    ['jkt', evidence.jkt],
    ['harness', evidence.harness],
    ['sessionId', evidence.sessionId],
    ['generation', evidence.generation],
    ['deviceId', evidence.deviceId],
    ['evidenceDigest', evidence.evidenceDigest],
  ];
}

function assertCreateTuple(tuple: PairingCreateTuple): void {
  assertText(tuple.ownerId, 'owner id');
  assertText(tuple.channelId, 'channel id');
  assertCanonicalOrigin(tuple.origin);
  assertText(tuple.descriptorId, 'descriptor identity');
  assertText(tuple.operationId, 'create operation');
}

function assertClaimEvidence(evidence: PairingClaimEvidence): void {
  assertText(evidence.ownerId, 'owner id');
  assertText(evidence.channelId, 'channel id');
  assertCanonicalOrigin(evidence.origin);
  assertText(evidence.descriptorId, 'descriptor identity');
  assertText(evidence.jkt, 'connector key thumbprint');
  assertText(evidence.harness, 'harness');
  assertText(evidence.sessionId, 'session id');
  if (!Number.isSafeInteger(evidence.generation) || evidence.generation < 0) throw new TypeError('generation must be a nonnegative safe integer');
  assertText(evidence.deviceId, 'device id');
  assertText(evidence.evidenceDigest, 'evidence digest');
}

function assertText(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be nonempty`);
}

function assertCanonicalCode(code: string): void {
  try {
    readCanonicalCode(code, 'code');
  } catch {
    throw new TypeError('expected one canonical pairing code');
  }
}

function assertCanonicalOrigin(origin: string): void {
  try {
    readCanonicalOrigin(origin, 'origin');
  } catch {
    throw new TypeError('pairing origin must be canonical');
  }
}
