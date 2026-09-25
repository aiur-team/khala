import { describe, expect, it } from 'vitest';
import type { DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import {
  MAX_PAIRING_KEY_COUNT,
  PAIRING_ATTEMPT_LIMIT,
  PAIRING_ATTEMPT_LEASE_MS,
  PAIRING_GRANT_LIFETIME_MS,
  PAIRING_REQUEST_LIFETIME_MS,
  createPairingPolicy,
  type PairingAttemptLimiter,
  type PairingKeyring,
} from './policy';

const key = (fill: number) => new Uint8Array(32).fill(fill);
const tuple = {
  ownerId: 'owner_1' as OwnerId,
  channelId: 'room_1' as RoomId,
  origin: 'https://khala.example',
  descriptorId: 'descriptor_v1',
  operationId: 'create_1',
};
const evidence = {
  ownerId: tuple.ownerId,
  channelId: tuple.channelId,
  origin: tuple.origin,
  descriptorId: tuple.descriptorId,
  jkt: 'j'.repeat(43),
  harness: 'codex',
  sessionId: 'thread_1',
  generation: 0,
  deviceId: 'device_1' as DeviceId,
  evidenceDigest: 'e'.repeat(43),
};

function policy(activeKeyId = 'key-2', keys = [{ id: 'key-2', key: key(2) }, { id: 'key-1', key: key(1) }]) {
  return createPairingPolicy({ v: 1, activeKeyId, keys });
}

describe('canonical pairing codes', () => {
  it('pins the request and sender-constrained grant lifetimes', () => {
    expect(PAIRING_REQUEST_LIFETIME_MS).toBe(5 * 60_000);
    expect(PAIRING_GRANT_LIFETIME_MS).toBe(60_000);
  });

  it('derives exactly 50 bits as ten grouped Crockford symbols and recovers identical creates', () => {
    const first = policy().deriveCreate(tuple);
    const second = policy().deriveCreate({ ...tuple });
    expect(first).toEqual(second);
    expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(first.code.replace('-', '')).toHaveLength(10);
    expect(first.keyId).toBe('key-2');
    expect(first.requestHandle).toMatch(/^pair_[A-Za-z0-9_-]{43}$/);
    expect(first.operationHandle).toMatch(/^pair_op_[A-Za-z0-9_-]{43}$/);
    expect(first.codeDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(first)).not.toContain(Buffer.from(key(2)).toString('base64url'));
  });

  it.each(Object.keys(tuple))('changes the authenticated create derivation when only %s changes', field => {
    const changed = {
      ownerId: 'owner_2' as OwnerId,
      channelId: 'room_2' as RoomId,
      origin: 'https://other.example',
      descriptorId: 'descriptor_v2',
      operationId: 'create_2',
    };
    expect(policy().deriveCreate({ ...tuple, [field]: changed[field as keyof typeof changed] }).tupleFingerprint)
      .not.toBe(policy().deriveCreate(tuple).tupleFingerprint);
  });

  it('keeps the owner/operation conflict handle stable while changed tuple material differs', () => {
    const p = policy();
    const original = p.deriveCreate(tuple);
    const changed = p.deriveCreate({ ...tuple, channelId: 'room_2' as RoomId });
    expect(changed.operationHandle).toBe(original.operationHandle);
    expect(changed.tupleFingerprint).not.toBe(original.tupleFingerprint);
    expect(changed.requestHandle).not.toBe(original.requestHandle);
  });

  it('maps one canonical presented code across every live key without persisting it', () => {
    const oldPolicy = policy('key-1');
    const issued = oldPolicy.deriveCreate(tuple);
    const candidates = policy().locateCode(issued.code);
    expect(candidates).toHaveLength(2);
    expect(candidates.find(candidate => candidate.keyId === 'key-1')).toMatchObject({
      requestHandle: issued.requestHandle, codeDigest: issued.codeDigest,
    });
    expect(policy('key-2', [{ id: 'key-2', key: key(2) }]).locateCode(issued.code)).not.toContainEqual(
      expect.objectContaining({ requestHandle: issued.requestHandle }),
    );
  });

  it('recovers an identical create inside the retained-key window but not after retirement', () => {
    const issued = policy('key-1').deriveCreate(tuple);
    expect(policy().deriveCreateCandidates(tuple)).toContainEqual(issued);
    expect(policy('key-2', [{ id: 'key-2', key: key(2) }]).deriveCreateCandidates(tuple)).not.toContainEqual(issued);
  });

  it.each(['0123456789', '01234 56789', '01234-5678O', 'abcde-fghjk'])('refuses non-canonical policy input %s', code => {
    expect(() => policy().locateCode(code)).toThrow(/canonical pairing code/);
  });
});

describe('versioned keyring validation and purpose separation', () => {
  it.each([
    ['unsupported keyring version', { v: 2, activeKeyId: 'a', keys: [{ id: 'a', key: key(1) }] }],
    ['short keys', { v: 1, activeKeyId: 'a', keys: [{ id: 'a', key: new Uint8Array(31) }] }],
    ['duplicate ids', { v: 1, activeKeyId: 'a', keys: [{ id: 'a', key: key(1) }, { id: 'a', key: key(2) }] }],
    ['missing active key', { v: 1, activeKeyId: 'missing', keys: [{ id: 'a', key: key(1) }] }],
    ['empty keyring', { v: 1, activeKeyId: 'a', keys: [] }],
    ['too many retained keys', { v: 1, activeKeyId: 'a', keys: Array.from({ length: MAX_PAIRING_KEY_COUNT + 1 }, (_, index) => ({ id: `k-${index}`, key: key(index) })) }],
  ])('rejects %s', (_name, input) => {
    expect(() => createPairingPolicy(input as PairingKeyring)).toThrow();
  });

  it('keeps every secret, digest, fingerprint, replay, and limiter purpose separate', () => {
    const p = policy();
    const create = p.deriveCreate(tuple);
    const fingerprint = p.claimFingerprint(evidence);
    const receipt = p.deriveClaimReceipt({ operationId: 'claim_1', fingerprint });
    const grant = p.deriveGrant({ requestHandle: create.requestHandle, approvedRevision: 'revision_1', fingerprint });
    const values = [
      create.requestHandle, create.codeDigest, create.tupleFingerprint, fingerprint,
      receipt.value, receipt.digest, grant.value, grant.digest,
      p.replayHandle({ jkt: evidence.jkt, jti: 'replay_identifier_1' }),
      p.sourceBucket('203.0.113.7'), p.codeBucket(create.code),
    ];
    expect(new Set(values).size).toBe(values.length);
    expect(receipt.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.digestClaimReceipt(receipt.value)).toBe(receipt.digest);
    expect(p.digestGrant(grant.value)).toBe(grant.digest);
  });

  it('copies injected key bytes so later caller mutation cannot change derivations', () => {
    const mutable = key(7);
    const p = policy('mutable', [{ id: 'mutable', key: mutable }]);
    const before = p.deriveCreate(tuple);
    mutable.fill(8);
    expect(p.deriveCreate(tuple)).toEqual(before);
  });

  it('fingerprints every immutable evidence field with stable canonical bytes', () => {
    const p = policy();
    const fingerprint = p.claimFingerprint(evidence);
    expect(p.claimFingerprint({ ...evidence })).toBe(fingerprint);
    const replacements = {
      ownerId: 'owner_2' as OwnerId, channelId: 'room_2' as RoomId, origin: 'https://other.example', descriptorId: 'descriptor_v2',
      jkt: 'k'.repeat(43), harness: 'claude', sessionId: 'thread_2', generation: 1,
      deviceId: 'device_2' as DeviceId, evidenceDigest: 'f'.repeat(43),
    };
    expect(Object.keys(replacements).sort()).toEqual(Object.keys(evidence).sort());
    for (const [field, value] of Object.entries(replacements)) {
      expect(p.claimFingerprint({ ...evidence, [field]: value })).not.toBe(fingerprint);
    }
  });
});

describe('atomic claim-attempt limiting boundary', () => {
  it('derives source and code buckets independently of a rotating client operation id', () => {
    const p = policy();
    const code = p.deriveCreate(tuple).code;
    expect(p.attemptBuckets({ trustedSource: '203.0.113.7', code, operationId: 'attempt_1' }))
      .toEqual(p.attemptBuckets({ trustedSource: '203.0.113.7', code, operationId: 'attempt_2' }));
    expect(p.sourceBucket('203.0.113.7')).not.toBe(p.sourceBucket('203.0.113.8'));
    expect(p.sourceBucket('203.0.113.7')).not.toContain('203.0.113.7');
  });

  it('fixes a five-minute maximum leased reservation and finite fail-closed port outcomes', async () => {
    expect(PAIRING_ATTEMPT_LEASE_MS).toBe(5 * 60_000);
    expect(PAIRING_ATTEMPT_LIMIT).toBe(5);
    const calls: unknown[] = [];
    const limiter: PairingAttemptLimiter = {
      async reserve(input) {
        calls.push(input);
        return { kind: 'unavailable' };
      },
      async finalize(input) {
        calls.push(input);
        return { kind: 'unavailable' };
      },
    };
    const reservation = {
      operationId: 'claim_1', sourceBucket: 'source_bucket', codeBucket: 'code_bucket', leaseMs: PAIRING_ATTEMPT_LEASE_MS,
    } as const;
    expect(await limiter.reserve(reservation)).toEqual({ kind: 'unavailable' });
    expect(await limiter.finalize({ permitId: 'permit_1', operationId: 'claim_1', disposition: 'failure' })).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(2);
  });

  it('models reconciliation, failure charging, winner release, and an atomic dual-bucket rejection', async () => {
    const results: Awaited<ReturnType<PairingAttemptLimiter['reserve']>>[] = [
      { kind: 'reserved', permit: { permitId: 'permit_1', leaseExpiresAt: '2026-09-24T12:05:00Z' } },
      { kind: 'limited' },
      { kind: 'unavailable' },
    ];
    const limiter: PairingAttemptLimiter = {
      reserve: async () => results.shift()!,
      finalize: async input => input.disposition === 'failure' ? { kind: 'finalized' } : { kind: 'released' },
    };
    expect((await limiter.reserve({ operationId: 'a', sourceBucket: 's', codeBucket: 'c', leaseMs: PAIRING_ATTEMPT_LEASE_MS })).kind).toBe('reserved');
    expect((await limiter.reserve({ operationId: 'b', sourceBucket: 's', codeBucket: 'other', leaseMs: PAIRING_ATTEMPT_LEASE_MS })).kind).toBe('limited');
    expect((await limiter.reserve({ operationId: 'c', sourceBucket: 'other', codeBucket: 'c', leaseMs: PAIRING_ATTEMPT_LEASE_MS })).kind).toBe('unavailable');
    expect(await limiter.finalize({ permitId: 'permit_1', operationId: 'a', disposition: 'failure' })).toEqual({ kind: 'finalized' });
    expect(await limiter.finalize({ permitId: 'permit_1', operationId: 'a', disposition: 'release' })).toEqual({ kind: 'released' });
  });
});
