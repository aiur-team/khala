// Durable pairing lifecycle. Raw codes, receipts and grants exist only at the
// method boundary; every durable locator and verifier is a purpose-separated
// keyed digest produced by PairingPolicy.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ControlRecord,
  ControlStore,
  DeviceId,
  JsonValue,
  OwnerId,
  PairingApprovalResult,
  PairingClaimProjection,
  PairingOwnerProjection,
  RoomId,
  TrustedClock,
  WriteResult,
} from '@khala/contracts/messaging/index';
import {
  PAIRING_GRANT_LIFETIME_MS,
  PAIRING_REQUEST_LIFETIME_MS,
  type PairingCreateTuple,
  type PairingPolicy,
} from './policy';

const REQUEST_PREFIX = 'pairing.request.';
const GRANT_PREFIX = 'pairing.grant.';
const REPLAY_PREFIX = 'pairing.replay.';

export type PairingClaimInput = Readonly<{
  code: string;
  operationId: string;
  jkt: string;
  harness: string;
  sessionId: string;
  generation: number;
  deviceId: DeviceId;
  evidenceDigest: string;
}>;

export type PairingDecisionInput = Readonly<{
  ownerId: OwnerId;
  requestHandle: string;
  revision: string;
  claimFingerprint: string;
  decision: 'approve' | 'deny';
  operationId: string;
}>;

export type PairingBootstrapAuthorization = Readonly<{
  v: 1;
  requestHandle: string;
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
  claimFingerprint: string;
  approvedAt: string;
  expiresAt: string;
}>;

export interface PairingGrantPort {
  redeem(input: Readonly<{ grant: string; operationId: string; jkt: string }>): Promise<
    | Readonly<{ kind: 'redeemed'; authorization: PairingBootstrapAuthorization }>
    | Readonly<{ kind: 'invalid_grant' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
}

export interface PairingStore {
  create(input: PairingCreateTuple): Promise<
    | Readonly<{ kind: 'created'; code: string; requestHandle: string; expiresAt: string }>
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  claim(input: PairingClaimInput): Promise<
    | Readonly<{ kind: 'claimed'; requestHandle: string; receipt: string }>
    | Readonly<{ kind: 'refused' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  inspect(input: Readonly<{ ownerId: OwnerId; requestHandle: string }>): Promise<
    | Readonly<{ kind: 'found'; projection: PairingOwnerProjection; revision: string }>
    | Readonly<{ kind: 'forbidden' }>
    | Readonly<{ kind: 'not_found' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  decide(input: PairingDecisionInput): Promise<
    | Readonly<{ kind: 'decided'; projection: PairingOwnerProjection; revision: string }>
    | Readonly<{ kind: 'stale' }>
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'expired' }>
    | Readonly<{ kind: 'forbidden' }>
    | Readonly<{ kind: 'not_found' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  result(input: Readonly<{ requestHandle: string; receipt: string; operationId: string; jkt: string }>): Promise<
    | Readonly<{ kind: 'result'; value: PairingApprovalResult }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  claimProofReplay(input: Readonly<{ jkt: string; jti: string; expiresAt: string }>): Promise<
    | Readonly<{ kind: 'claimed' }>
    | Readonly<{ kind: 'replayed' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  grantPort: PairingGrantPort;
}

type StoredClaim = Readonly<{
  operationId: string;
  fingerprint: string;
  receiptDigest: string;
  receiptKeyId: string;
  claimedAt: string;
  jkt: string;
  harness: string;
  sessionId: string;
  generation: number;
  deviceId: DeviceId;
  evidenceDigest: string;
}>;

type StoredDecision = Readonly<{
  operationId: string;
  kind: 'approve' | 'deny';
  fingerprint: string;
  displayedRevision: string;
  decidedAt: string;
}>;

type RequestRecord = Readonly<{
  v: 1;
  recordType: 'pairing_request';
  keyId: string;
  codeDigest: string;
  tupleFingerprint: string;
  ownerId: OwnerId;
  channelId: RoomId;
  origin: string;
  descriptorId: string;
  createOperationId: string;
  createdAt: string;
  expiresAt: string;
  state: 'issued' | 'claimed' | 'approved' | 'denied' | 'expired';
  claim: StoredClaim | null;
  decision: StoredDecision | null;
}>;

type GrantBinding = PairingBootstrapAuthorization;

type GrantRecord = Readonly<{
  v: 1;
  recordType: 'pairing_grant';
  keyId: string;
  requestHandle: string;
  resultOperationId: string;
  state: 'unspent' | 'spent' | 'expired';
  binding: GrantBinding;
  redemption: Readonly<{ operationId: string; authorization: PairingBootstrapAuthorization }> | null;
}>;

type DomainRecord<T> = Readonly<{ envelope: ControlRecord; value: T }>;
type Settled<T extends JsonValue> =
  | Readonly<{ kind: 'applied'; record: ControlRecord<T> }>
  | Readonly<{ kind: 'conflict'; current: ControlRecord<T> | null }>
  | Readonly<{ kind: 'operation_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>;

export function createPairingStore(deps: Readonly<{
  store: ControlStore;
  policy: PairingPolicy;
  clock: TrustedClock;
  random?: (bytes: number) => Uint8Array;
}>): PairingStore {
  const { policy, clock } = deps;
  const random = deps.random ?? ((bytes: number) => randomBytes(bytes));
  const requestKey = (requestHandle: string) => `${REQUEST_PREFIX}${requestHandle}`;
  const grantKey = (digest: string) => `${GRANT_PREFIX}${digest}`;

  async function read(key: string): Promise<Awaited<ReturnType<ControlStore['read']>>> {
    try {
      return await deps.store.read(key);
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function write<T extends JsonValue>(input: Parameters<ControlStore['compareAndSet']>[0] & { next: { value: T; expiresAt: string | null } }): Promise<Settled<T>> {
    let first: WriteResult<T>;
    try {
      first = await deps.store.compareAndSet<T>(input);
    } catch {
      return { kind: 'unavailable' };
    }
    if (first.kind === 'applied' || first.kind === 'conflict' || first.kind === 'operation_mismatch' || first.kind === 'unavailable') return first;
    let resolved;
    try {
      resolved = await deps.store.resolve<T>({ key: input.key, operationId: input.operationId });
    } catch {
      return { kind: 'unavailable' };
    }
    if (resolved.kind === 'applied') return resolved;
    if (resolved.kind !== 'not_applied') return { kind: 'unavailable' };
    try {
      const retried = await deps.store.compareAndSet<T>(input);
      if (retried.kind === 'applied' || retried.kind === 'conflict' || retried.kind === 'operation_mismatch' || retried.kind === 'unavailable') return retried;
    } catch {
      // Converted below.
    }
    return { kind: 'unavailable' };
  }

  async function readRequest(handle: string): Promise<DomainRecord<RequestRecord> | 'absent' | 'unavailable'> {
    const result = await read(requestKey(handle));
    if (result.kind !== 'record') return result.kind;
    const value = decodeRequest(result.record.value);
    return value ? { envelope: result.record, value } : 'unavailable';
  }

  async function readGrant(digest: string): Promise<DomainRecord<GrantRecord> | 'absent' | 'unavailable'> {
    const result = await read(grantKey(digest));
    if (result.kind !== 'record') return result.kind;
    const value = decodeGrant(result.record.value);
    return value ? { envelope: result.record, value } : 'unavailable';
  }

  async function expireRequest(handle: string, initial: DomainRecord<RequestRecord>): Promise<DomainRecord<RequestRecord> | 'unavailable'> {
    let current = initial;
    for (;;) {
      if (current.value.state !== 'issued' && current.value.state !== 'claimed') return current;
      if (clock() < Date.parse(current.value.expiresAt)) return current;
      const next: RequestRecord = { ...current.value, state: 'expired' };
      const settled = await write({
        key: requestKey(handle),
        expectedRevision: current.envelope.revision,
        operationId: operation('request-expire', handle, current.envelope.revision),
        next: permanent(next),
      });
      if (settled.kind === 'applied') return { envelope: settled.record, value: next };
      if (settled.kind === 'unavailable' || settled.kind === 'operation_mismatch') return 'unavailable';
      const reread = await readRequest(handle);
      if (reread === 'unavailable' || reread === 'absent') return 'unavailable';
      current = reread;
    }
  }

  function createResponse(code: string, handle: string, value: RequestRecord) {
    return { kind: 'created' as const, code, requestHandle: handle, expiresAt: value.expiresAt };
  }

  async function create(input: PairingCreateTuple): ReturnType<PairingStore['create']> {
    let candidates;
    try {
      candidates = policy.deriveCreateCandidates(input);
    } catch {
      return { kind: 'unavailable' };
    }
    for (const candidate of candidates) {
      const existing = await readRequest(candidate.requestHandle);
      if (existing === 'unavailable') return { kind: 'unavailable' };
      if (existing !== 'absent') {
        return sameCreate(existing.value, input, candidate.tupleFingerprint, candidate.codeDigest)
          ? createResponse(candidate.code, candidate.requestHandle, existing.value)
          : { kind: 'conflict' };
      }
    }

    const active = candidates[0];
    if (!active) return { kind: 'unavailable' };
    const now = clock();
    const value: RequestRecord = {
      v: 1,
      recordType: 'pairing_request',
      keyId: active.keyId,
      codeDigest: active.codeDigest,
      tupleFingerprint: active.tupleFingerprint,
      ownerId: input.ownerId,
      channelId: input.channelId,
      origin: input.origin,
      descriptorId: input.descriptorId,
      createOperationId: input.operationId,
      createdAt: iso(now),
      expiresAt: iso(now + PAIRING_REQUEST_LIFETIME_MS),
      state: 'issued',
      claim: null,
      decision: null,
    };
    const settled = await write({
      key: requestKey(active.requestHandle),
      expectedRevision: null,
      // Stable across key rotation and deliberately excludes tuple fields, so
      // one owner operation cannot create different authoritative requests.
      operationId: operation('request-create', input.ownerId, input.operationId),
      next: permanent(value),
    });
    if (settled.kind === 'operation_mismatch') return { kind: 'conflict' };
    if (settled.kind === 'unavailable') return { kind: 'unavailable' };
    if (settled.kind === 'applied') return createResponse(active.code, active.requestHandle, value);
    const current = settled.current && decodeRequest(settled.current.value);
    return current && sameCreate(current, input, active.tupleFingerprint, active.codeDigest)
      ? createResponse(active.code, active.requestHandle, current)
      : { kind: 'conflict' };
  }

  async function claim(input: PairingClaimInput): ReturnType<PairingStore['claim']> {
    let candidates;
    try {
      candidates = policy.locateCode(input.code);
    } catch {
      return { kind: 'refused' };
    }
    for (const candidate of candidates) {
      const located = await readRequest(candidate.requestHandle);
      if (located === 'unavailable') return { kind: 'unavailable' };
      if (located === 'absent') continue;
      if (located.value.keyId !== candidate.keyId || !equalSecret(located.value.codeDigest, candidate.codeDigest)) continue;
      let current = located;
      for (;;) {
        const evidence = {
          ownerId: current.value.ownerId,
          channelId: current.value.channelId,
          origin: current.value.origin,
          descriptorId: current.value.descriptorId,
          jkt: input.jkt,
          harness: input.harness,
          sessionId: input.sessionId,
          generation: input.generation,
          deviceId: input.deviceId,
          evidenceDigest: input.evidenceDigest,
        };
        let fingerprint: string;
        try {
          fingerprint = policy.claimFingerprint(evidence, current.value.keyId);
        } catch {
          return { kind: 'unavailable' };
        }
        if (current.value.claim?.operationId === input.operationId
          && equalSecret(current.value.claim.fingerprint, fingerprint)) {
          const receipt = policy.deriveClaimReceipt({ operationId: input.operationId, fingerprint, keyId: current.value.claim.receiptKeyId });
          return equalSecret(receipt.digest, current.value.claim.receiptDigest)
            ? { kind: 'claimed', requestHandle: candidate.requestHandle, receipt: receipt.value }
            : { kind: 'unavailable' };
        }
        if (current.value.state !== 'issued') return { kind: 'refused' };
        // Trusted time is deliberately sampled immediately before the guarded
        // request CAS. At the boundary, expiration wins instead of a stale claim.
        const now = clock();
        if (now >= Date.parse(current.value.expiresAt)) {
          const expired = await expireRequest(candidate.requestHandle, current);
          return expired === 'unavailable' ? { kind: 'unavailable' } : { kind: 'refused' };
        }
        let receipt;
        try {
          receipt = policy.deriveClaimReceipt({ operationId: input.operationId, fingerprint, keyId: current.value.keyId });
        } catch {
          return { kind: 'unavailable' };
        }
        const storedClaim: StoredClaim = {
          operationId: input.operationId,
          fingerprint,
          receiptDigest: receipt.digest,
          receiptKeyId: receipt.keyId,
          claimedAt: iso(Math.max(now, Date.parse(current.value.createdAt) + 1)),
          jkt: input.jkt,
          harness: input.harness,
          sessionId: input.sessionId,
          generation: input.generation,
          deviceId: input.deviceId,
          evidenceDigest: input.evidenceDigest,
        };
        const next: RequestRecord = { ...current.value, state: 'claimed', claim: storedClaim };
        // MUTATION GUARD: this exact expected revision is the one-winner claim linearization point.
        const claimed = await write({
          key: requestKey(candidate.requestHandle),
          expectedRevision: current.envelope.revision,
          operationId: operation('request-claim', candidate.requestHandle, input.operationId),
          next: permanent(next),
        });
        if (claimed.kind === 'applied') return { kind: 'claimed', requestHandle: candidate.requestHandle, receipt: receipt.value };
        if (claimed.kind === 'unavailable') return { kind: 'unavailable' };
        if (claimed.kind === 'operation_mismatch') return { kind: 'refused' };
        // A conflict is never interpreted from stale state. Re-read, recompute
        // trusted time and either reconcile the exact winner or observe expiry.
        const reread = await readRequest(candidate.requestHandle);
        if (reread === 'unavailable') return { kind: 'unavailable' };
        if (reread === 'absent') return { kind: 'refused' };
        current = reread;
      }
    }
    return { kind: 'refused' };
  }

  async function inspect(input: Readonly<{ ownerId: OwnerId; requestHandle: string }>): ReturnType<PairingStore['inspect']> {
    const found = await readRequest(input.requestHandle);
    if (found === 'unavailable') return { kind: 'unavailable' };
    if (found === 'absent') return { kind: 'not_found' };
    if (found.value.ownerId !== input.ownerId) return { kind: 'forbidden' };
    const current = await expireRequest(input.requestHandle, found);
    if (current === 'unavailable') return { kind: 'unavailable' };
    return foundProjection(input.requestHandle, current);
  }

  async function decide(input: PairingDecisionInput): ReturnType<PairingStore['decide']> {
    for (;;) {
      const found = await readRequest(input.requestHandle);
      if (found === 'unavailable') return { kind: 'unavailable' };
      if (found === 'absent') return { kind: 'not_found' };
      if (found.value.ownerId !== input.ownerId) return { kind: 'forbidden' };
      const currentDecision = found.value.decision;
      if (found.value.state === 'approved' || found.value.state === 'denied') {
        const exact = currentDecision
          && currentDecision.operationId === input.operationId
          && currentDecision.kind === input.decision
          && currentDecision.displayedRevision === input.revision
          && equalSecret(currentDecision.fingerprint, input.claimFingerprint);
        return exact ? decidedProjection(input.requestHandle, found) : { kind: 'conflict' };
      }
      if (found.value.state === 'expired') return { kind: 'expired' };
      if (found.value.state !== 'claimed' || !found.value.claim
        || found.envelope.revision !== input.revision
        || !equalSecret(found.value.claim.fingerprint, input.claimFingerprint)) return { kind: 'stale' };

      // Approval/denial samples time immediately before its authoritative CAS.
      const now = clock();
      if (now >= Date.parse(found.value.expiresAt)) {
        const expired = await expireRequest(input.requestHandle, found);
        return expired === 'unavailable' ? { kind: 'unavailable' } : { kind: 'expired' };
      }
      const decision: StoredDecision = {
        operationId: input.operationId,
        kind: input.decision,
        fingerprint: input.claimFingerprint,
        displayedRevision: input.revision,
        decidedAt: iso(Math.max(now, Date.parse(found.value.claim.claimedAt))),
      };
      const next: RequestRecord = {
        ...found.value,
        state: input.decision === 'approve' ? 'approved' : 'denied',
        decision,
      };
      const settled = await write({
        key: requestKey(input.requestHandle),
        expectedRevision: found.envelope.revision,
        operationId: operation('request-decision', input.requestHandle, input.operationId),
        next: permanent(next),
      });
      if (settled.kind === 'applied') return decidedProjection(input.requestHandle, { envelope: settled.record, value: next });
      if (settled.kind === 'unavailable') return { kind: 'unavailable' };
      if (settled.kind === 'operation_mismatch') return { kind: 'conflict' };
      // Conflict always starts over with a fresh authoritative read and clock.
    }
  }

  async function result(input: Readonly<{ requestHandle: string; receipt: string; operationId: string; jkt: string }>): ReturnType<PairingStore['result']> {
    const found = await readRequest(input.requestHandle);
    if (found === 'unavailable') return { kind: 'unavailable' };
    if (found === 'absent' || !found.value.claim) return { kind: 'invalid' };
    let receiptDigest: string;
    try {
      receiptDigest = policy.digestClaimReceipt(input.receipt, found.value.claim.receiptKeyId);
    } catch {
      return { kind: 'invalid' };
    }
    if (!equalSecret(receiptDigest, found.value.claim.receiptDigest) || input.jkt !== found.value.claim.jkt) return { kind: 'invalid' };

    let current: DomainRecord<RequestRecord> = found;
    if (current.value.state === 'claimed') {
      const afterExpiry = await expireRequest(input.requestHandle, current);
      if (afterExpiry === 'unavailable') return { kind: 'unavailable' };
      current = afterExpiry;
    }
    if (current.value.state === 'claimed') return { kind: 'result', value: { v: 1, state: 'pending' } };
    if (current.value.state === 'expired') return { kind: 'result', value: { v: 1, state: 'expired' } };
    if (current.value.state === 'denied') {
      if (!current.value.decision) return { kind: 'unavailable' };
      return { kind: 'result', value: { v: 1, state: 'denied', decidedAt: current.value.decision.decidedAt } };
    }
    if (current.value.state !== 'approved' || !current.value.decision || !current.value.claim) return { kind: 'invalid' };
    const approvedClaim = current.value.claim;
    const approvedAtMs = Date.parse(current.value.decision.decidedAt);
    const grantExpiresAt = iso(approvedAtMs + PAIRING_GRANT_LIFETIME_MS);
    let secret;
    try {
      secret = policy.deriveGrant({
        requestHandle: input.requestHandle,
        approvedRevision: current.envelope.revision,
        fingerprint: approvedClaim.fingerprint,
        keyId: current.value.keyId,
      });
    } catch {
      return { kind: 'unavailable' };
    }
    if (clock() >= Date.parse(grantExpiresAt)) {
      const existing = await readGrant(secret.digest);
      if (existing === 'unavailable') return { kind: 'unavailable' };
      if (existing !== 'absent' && existing.value.state === 'unspent') {
        const expired = await expireGrant(secret.digest, existing);
        if (expired === 'unavailable') return { kind: 'unavailable' };
      }
      return { kind: 'result', value: { v: 1, state: 'expired' } };
    }

    const binding: GrantBinding = {
      v: 1,
      requestHandle: input.requestHandle,
      ownerId: current.value.ownerId,
      channelId: current.value.channelId,
      origin: current.value.origin,
      descriptorId: current.value.descriptorId,
      jkt: approvedClaim.jkt,
      harness: approvedClaim.harness,
      sessionId: approvedClaim.sessionId,
      generation: approvedClaim.generation,
      deviceId: approvedClaim.deviceId,
      evidenceDigest: approvedClaim.evidenceDigest,
      claimFingerprint: approvedClaim.fingerprint,
      approvedAt: current.value.decision.decidedAt,
      expiresAt: grantExpiresAt,
    };
    const grant: GrantRecord = {
      v: 1,
      recordType: 'pairing_grant',
      keyId: secret.keyId,
      requestHandle: input.requestHandle,
      resultOperationId: input.operationId,
      state: 'unspent',
      binding,
      redemption: null,
    };
    const issued = await write({
      key: grantKey(secret.digest),
      expectedRevision: null,
      operationId: operation('grant-issue', input.requestHandle, current.envelope.revision, input.operationId),
      next: permanent(grant),
    });
    if (issued.kind === 'unavailable' || issued.kind === 'operation_mismatch') return { kind: 'unavailable' };
    // `applied` may be the historical result of this stable issue operation
    // even when a later redemption has superseded it. Disclosure therefore
    // depends only on a fresh read of the authoritative current grant record.
    const authoritative = await readGrant(secret.digest);
    if (authoritative === 'unavailable' || authoritative === 'absent' || !sameGrantBinding(authoritative.value, grant)) {
      return { kind: 'unavailable' };
    }
    if (authoritative.value.resultOperationId !== input.operationId) return { kind: 'invalid' };
    if (authoritative.value.state !== 'unspent') return { kind: 'result', value: { v: 1, state: 'expired' } };
    return { kind: 'result', value: { v: 1, state: 'approved', grant: secret.value, expiresAt: grantExpiresAt } };
  }

  async function expireGrant(digest: string, initial: DomainRecord<GrantRecord>): Promise<DomainRecord<GrantRecord> | 'unavailable'> {
    let current = initial;
    for (;;) {
      if (current.value.state !== 'unspent' || clock() < Date.parse(current.value.binding.expiresAt)) return current;
      const next: GrantRecord = { ...current.value, state: 'expired' };
      const settled = await write({
        key: grantKey(digest),
        expectedRevision: current.envelope.revision,
        operationId: operation('grant-expire', digest, current.envelope.revision),
        next: permanent(next),
      });
      if (settled.kind === 'applied') return { envelope: settled.record, value: next };
      if (settled.kind === 'unavailable' || settled.kind === 'operation_mismatch') return 'unavailable';
      const reread = await readGrant(digest);
      if (reread === 'unavailable' || reread === 'absent') return 'unavailable';
      current = reread;
    }
  }

  const grantPort: PairingGrantPort = {
    async redeem(input) {
      let candidates;
      try {
        candidates = policy.digestGrantCandidates(input.grant);
      } catch {
        return { kind: 'invalid_grant' };
      }
      for (const candidate of candidates) {
        const located = await readGrant(candidate.digest);
        if (located === 'unavailable') return { kind: 'unavailable' };
        if (located === 'absent') continue;
        let current = located;
        for (;;) {
          if (current.value.keyId !== candidate.keyId || current.value.binding.jkt !== input.jkt) return { kind: 'invalid_grant' };
          if (current.value.state === 'spent') {
            return current.value.redemption?.operationId === input.operationId
              ? { kind: 'redeemed', authorization: current.value.redemption.authorization }
              : { kind: 'invalid_grant' };
          }
          if (current.value.state === 'expired') return { kind: 'invalid_grant' };
          // Grant expiry is sampled immediately before its spend CAS.
          if (clock() >= Date.parse(current.value.binding.expiresAt)) {
            const expired = await expireGrant(candidate.digest, current);
            return expired === 'unavailable' ? { kind: 'unavailable' } : { kind: 'invalid_grant' };
          }
          const next: GrantRecord = {
            ...current.value,
            state: 'spent',
            redemption: { operationId: input.operationId, authorization: current.value.binding },
          };
          const spent = await write({
            key: grantKey(candidate.digest),
            expectedRevision: current.envelope.revision,
            operationId: operation('grant-redeem', candidate.digest, input.operationId),
            next: permanent(next),
          });
          if (spent.kind === 'applied') return { kind: 'redeemed', authorization: current.value.binding };
          if (spent.kind === 'unavailable') return { kind: 'unavailable' };
          if (spent.kind === 'operation_mismatch') return { kind: 'invalid_grant' };
          const reread = await readGrant(candidate.digest);
          if (reread === 'unavailable') return { kind: 'unavailable' };
          if (reread === 'absent') return { kind: 'invalid_grant' };
          current = reread;
        }
      }
      return { kind: 'invalid_grant' };
    },
  };

  async function claimProofReplay(input: Readonly<{ jkt: string; jti: string; expiresAt: string }>): ReturnType<PairingStore['claimProofReplay']> {
    let handle: string;
    try {
      handle = policy.replayHandle({ jkt: input.jkt, jti: input.jti });
    } catch {
      return { kind: 'unavailable' };
    }
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= clock()) return { kind: 'replayed' };
    // A fresh write identity per invocation is intentional: idempotently
    // reusing one would make a second presentation look like the first claim.
    let writeId: string;
    try {
      const bytes = random(18);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 18) return { kind: 'unavailable' };
      writeId = `pairing.replay.${Buffer.from(bytes).toString('base64url')}`;
    } catch {
      return { kind: 'unavailable' };
    }
    const settled = await write({
      key: `${REPLAY_PREFIX}${handle}`,
      expectedRevision: null,
      operationId: writeId,
      next: { value: { v: 1, claimed: true }, expiresAt: input.expiresAt },
    });
    if (settled.kind === 'applied') return { kind: 'claimed' };
    if (settled.kind === 'conflict' || settled.kind === 'operation_mismatch') return { kind: 'replayed' };
    return { kind: 'unavailable' };
  }

  return { create, claim, inspect, decide, result, claimProofReplay, grantPort };
}

function permanent<T>(value: T): { value: JsonValue; expiresAt: null } {
  return { value: value as unknown as JsonValue, expiresAt: null };
}

function operation(scope: string, ...fields: string[]): string {
  return `pairing.${scope}.${createHash('sha256').update(JSON.stringify(fields)).digest('base64url')}`;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function sameCreate(record: RequestRecord, input: PairingCreateTuple, tupleFingerprint: string, codeDigest: string): boolean {
  return record.ownerId === input.ownerId
    && record.channelId === input.channelId
    && record.origin === input.origin
    && record.descriptorId === input.descriptorId
    && record.createOperationId === input.operationId
    && equalSecret(record.tupleFingerprint, tupleFingerprint)
    && equalSecret(record.codeDigest, codeDigest);
}

function projection(handle: string, record: RequestRecord): PairingOwnerProjection {
  const claim: PairingClaimProjection | null = record.claim ? {
    jkt: record.claim.jkt,
    harness: record.claim.harness,
    sessionId: record.claim.sessionId,
    generation: record.claim.generation,
    deviceId: record.claim.deviceId,
    evidenceDigest: record.claim.evidenceDigest,
    fingerprint: record.claim.fingerprint,
    verification: 'connector_verified',
  } : null;
  return {
    v: 1,
    requestHandle: handle,
    state: record.state,
    channelId: record.channelId,
    origin: record.origin,
    descriptorId: record.descriptorId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    claim,
    decidedAt: record.decision?.decidedAt ?? null,
  };
}

function foundProjection(handle: string, record: DomainRecord<RequestRecord>) {
  return { kind: 'found' as const, projection: projection(handle, record.value), revision: record.envelope.revision };
}

function decidedProjection(handle: string, record: DomainRecord<RequestRecord>) {
  return { kind: 'decided' as const, projection: projection(handle, record.value), revision: record.envelope.revision };
}

function sameGrantBinding(left: GrantRecord, right: GrantRecord): boolean {
  return left.keyId === right.keyId
    && left.requestHandle === right.requestHandle
    && JSON.stringify(left.binding) === JSON.stringify(right.binding);
}

function decodeRequest(input: JsonValue): RequestRecord | null {
  if (!object(input) || !exactKeys(input, [
    'v', 'recordType', 'keyId', 'codeDigest', 'tupleFingerprint', 'ownerId', 'channelId', 'origin', 'descriptorId',
    'createOperationId', 'createdAt', 'expiresAt', 'state', 'claim', 'decision',
  ]) || input.v !== 1 || input.recordType !== 'pairing_request') return null;
  if (!text(input.keyId) || !text(input.codeDigest) || !text(input.tupleFingerprint)
    || !text(input.ownerId) || !text(input.channelId) || !text(input.origin) || !text(input.descriptorId)
    || !text(input.createOperationId) || !timestamp(input.createdAt) || !timestamp(input.expiresAt)
    || !['issued', 'claimed', 'approved', 'denied', 'expired'].includes(String(input.state))) return null;
  if (!Object.hasOwn(input, 'claim') || !Object.hasOwn(input, 'decision')) return null;
  const rawClaim = input.claim;
  const rawDecision = input.decision;
  if (rawClaim === undefined || rawDecision === undefined) return null;
  const claim = rawClaim === null ? null : decodeClaim(rawClaim);
  const decision = rawDecision === null ? null : decodeDecision(rawDecision);
  if ((input.claim !== null && !claim) || (input.decision !== null && !decision)) return null;
  const createdAt = Date.parse(input.createdAt as string);
  const expiresAt = Date.parse(input.expiresAt as string);
  if (createdAt >= expiresAt) return null;
  if (claim) {
    const claimedAt = Date.parse(claim.claimedAt);
    if (!(createdAt < claimedAt && claimedAt < expiresAt)) return null;
  }
  if (decision) {
    if (!claim || !equalSecret(decision.fingerprint, claim.fingerprint)) return null;
    const claimedAt = Date.parse(claim.claimedAt);
    const decidedAt = Date.parse(decision.decidedAt);
    if (!(claimedAt <= decidedAt && decidedAt < expiresAt)) return null;
  }
  if (input.state === 'issued' && (claim !== null || decision !== null)) return null;
  if (input.state === 'claimed' && (claim === null || decision !== null)) return null;
  if (input.state === 'approved' && (claim === null || decision?.kind !== 'approve')) return null;
  if (input.state === 'denied' && (claim === null || decision?.kind !== 'deny')) return null;
  if (input.state === 'expired' && decision !== null) return null;
  return { ...input, claim, decision } as unknown as RequestRecord;
}

function decodeClaim(input: JsonValue): StoredClaim | null {
  if (!object(input) || !exactKeys(input, [
    'operationId', 'fingerprint', 'receiptDigest', 'receiptKeyId', 'claimedAt', 'jkt', 'harness', 'sessionId',
    'generation', 'deviceId', 'evidenceDigest',
  ]) || !text(input.operationId) || !text(input.fingerprint) || !text(input.receiptDigest)
    || !text(input.receiptKeyId) || !timestamp(input.claimedAt) || !text(input.jkt) || !text(input.harness)
    || !text(input.sessionId) || !Number.isSafeInteger(input.generation) || Number(input.generation) < 0
    || !text(input.deviceId) || !text(input.evidenceDigest)) return null;
  return input as unknown as StoredClaim;
}

function decodeDecision(input: JsonValue): StoredDecision | null {
  if (!object(input) || !exactKeys(input, ['operationId', 'kind', 'fingerprint', 'displayedRevision', 'decidedAt'])
    || !text(input.operationId) || (input.kind !== 'approve' && input.kind !== 'deny')
    || !text(input.fingerprint) || !text(input.displayedRevision) || !timestamp(input.decidedAt)) return null;
  return input as unknown as StoredDecision;
}

function decodeGrant(input: JsonValue): GrantRecord | null {
  if (!object(input) || !exactKeys(input, ['v', 'recordType', 'keyId', 'requestHandle', 'resultOperationId', 'state', 'binding', 'redemption'])
    || input.v !== 1 || input.recordType !== 'pairing_grant' || !text(input.keyId)
    || !text(input.requestHandle) || !text(input.resultOperationId)
    || !['unspent', 'spent', 'expired'].includes(String(input.state)) || !decodeBinding(input.binding)) return null;
  const binding = input.binding as unknown as PairingBootstrapAuthorization;
  if (input.requestHandle !== binding.requestHandle
    || Date.parse(binding.expiresAt) - Date.parse(binding.approvedAt) !== PAIRING_GRANT_LIFETIME_MS) return null;
  let redemption: GrantRecord['redemption'] = null;
  if (input.redemption !== null) {
    if (!object(input.redemption) || !exactKeys(input.redemption, ['operationId', 'authorization'])
      || !text(input.redemption.operationId) || !decodeBinding(input.redemption.authorization)) return null;
    redemption = input.redemption as unknown as NonNullable<GrantRecord['redemption']>;
    if (!sameAuthorization(redemption.authorization, binding)) return null;
  }
  if ((input.state === 'spent') !== (redemption !== null)) return null;
  return { ...input, redemption } as unknown as GrantRecord;
}

function decodeBinding(input: JsonValue | undefined): input is JsonValue {
  return object(input) && exactKeys(input, [
    'v', 'requestHandle', 'ownerId', 'channelId', 'origin', 'descriptorId', 'jkt', 'harness', 'sessionId', 'generation',
    'deviceId', 'evidenceDigest', 'claimFingerprint', 'approvedAt', 'expiresAt',
  ]) && input.v === 1 && text(input.requestHandle) && text(input.ownerId) && text(input.channelId)
    && text(input.origin) && text(input.descriptorId) && text(input.jkt) && text(input.harness) && text(input.sessionId)
    && Number.isSafeInteger(input.generation) && Number(input.generation) >= 0 && text(input.deviceId)
    && text(input.evidenceDigest) && text(input.claimFingerprint) && timestamp(input.approvedAt) && timestamp(input.expiresAt);
}

function sameAuthorization(left: PairingBootstrapAuthorization, right: PairingBootstrapAuthorization): boolean {
  const fields: readonly (keyof PairingBootstrapAuthorization)[] = [
    'v', 'requestHandle', 'ownerId', 'channelId', 'origin', 'descriptorId', 'jkt', 'harness', 'sessionId', 'generation',
    'deviceId', 'evidenceDigest', 'claimFingerprint', 'approvedAt', 'expiresAt',
  ];
  return fields.every(field => left[field] === right[field]);
}

function object(input: JsonValue | undefined): input is { readonly [key: string]: JsonValue } {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function exactKeys(input: { readonly [key: string]: JsonValue }, keys: readonly string[]): boolean {
  const actual = Object.keys(input);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(input, key));
}

function text(input: JsonValue | undefined): input is string {
  return typeof input === 'string' && input.length > 0;
}

function timestamp(input: JsonValue | undefined): input is string {
  return text(input) && Number.isFinite(Date.parse(input));
}
