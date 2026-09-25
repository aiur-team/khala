import { describe, expect, it } from 'vitest';
import {
  PAIRING_FAILURE_CODES,
  decodePairingApprovalResult,
  decodePairingClaimResult,
  decodePairingClaimRequest,
  decodePairingCreateResult,
  decodePairingCreateRequest,
  decodePairingDecisionResult,
  decodePairingDecisionRequest,
  decodePairingFailure,
  decodePairingGrantRedemptionRequest,
  decodePairingOwnerProjection,
  decodePairingOwnerResult,
  decodePairingResultRequest,
} from './pairing';

const digest = 'A'.repeat(43);
const create = {
  v: 1, channelId: 'room_alpha', origin: 'https://khala.example', descriptorId: 'descriptor_v1', operationId: 'create_1',
};
const claim = {
  v: 1, code: '01234-56789', operationId: 'claim_1', jkt: digest, harness: 'codex', sessionId: 'thread_1',
  generation: 0, deviceId: 'device_1', evidenceDigest: digest,
};
const claimView = {
  jkt: digest, harness: 'codex', sessionId: 'thread_1', generation: 0, deviceId: 'device_1', evidenceDigest: digest,
  fingerprint: digest, verification: 'connector_verified',
};
const projection = {
  v: 1, requestHandle: `pair_${digest}`, state: 'claimed', channelId: 'room_alpha', origin: 'https://khala.example',
  descriptorId: 'descriptor_v1', createdAt: '2026-09-24T12:00:00Z', expiresAt: '2026-09-24T12:05:00Z',
  claim: claimView, decidedAt: null,
};

describe('pairing request contracts', () => {
  it('round-trips exact version-one request, claim, result, decision, and redemption bodies', () => {
    expect(decodePairingCreateRequest(create)).toEqual({ ok: true, value: create });
    expect(decodePairingClaimRequest(claim)).toEqual({ ok: true, value: claim });
    expect(decodePairingResultRequest({ v: 1, requestHandle: `pair_${digest}`, receipt: digest, operationId: 'result_1', jkt: digest })).toEqual({
      ok: true, value: { v: 1, requestHandle: `pair_${digest}`, receipt: digest, operationId: 'result_1', jkt: digest },
    });
    expect(decodePairingResultRequest({ v: 1, requestHandle: `pair_${digest}`, receipt: digest, operationId: 'result_1' })).toEqual({
      ok: false, error: { path: 'jkt', code: 'missing_field' },
    });
    const decision = {
      v: 1, requestHandle: `pair_${digest}`, revision: 'revision_1', claimFingerprint: digest, decision: 'approve', operationId: 'decision_1',
    };
    expect(decodePairingDecisionRequest(decision)).toEqual({ ok: true, value: decision });
    expect(decodePairingGrantRedemptionRequest({ v: 1, grant: digest, operationId: 'redeem_1' })).toEqual({
      ok: true, value: { v: 1, grant: digest, operationId: 'redeem_1' },
    });
  });

  it.each([
    ['unknown fields', { ...create, authorization: 'Bearer secret' }, 'authorization', 'unknown_field'],
    ['unsupported versions', { ...create, v: 2 }, 'v', 'unsupported_version'],
    ['non-canonical origins', { ...create, origin: 'https://khala.example/' }, 'origin', 'invalid_value'],
    ['malformed origins', { ...create, origin: 'not an origin' }, 'origin', 'invalid_value'],
  ])('rejects %s', (_name, input, path, code) => {
    expect(decodePairingCreateRequest(input)).toEqual({ ok: false, error: { path, code } });
  });

  it.each(['0123456789', '01234 56789', '01234-5678O', '01234-5678I', '01234-5678L', '01234-5678U', 'abcde-fghjk'])
    ('rejects non-canonical wire code %s', code => {
      expect(decodePairingClaimRequest({ ...claim, code })).toEqual({ ok: false, error: { path: 'code', code: 'invalid_value' } });
    });

  it('rejects unsafe generations and malformed digest material', () => {
    expect(decodePairingClaimRequest({ ...claim, generation: Number.MAX_SAFE_INTEGER + 1 })).toEqual({
      ok: false, error: { path: 'generation', code: 'unsafe_integer' },
    });
    expect(decodePairingClaimRequest({ ...claim, evidenceDigest: 'sha256:not-base64url' })).toEqual({
      ok: false, error: { path: 'evidenceDigest', code: 'invalid_value' },
    });
  });
});

describe('pairing success result contracts', () => {
  const created = {
    v: 1, state: 'issued', code: '01234-56789', requestHandle: `pair_${digest}`, expiresAt: '2026-09-24T12:05:00Z',
  };
  const claimed = { v: 1, state: 'pending', requestHandle: `pair_${digest}`, receipt: digest };
  const owner = { ...projection, revision: 'revision_1' };

  it('round-trips exact create, claim, inspect, and decision results', () => {
    expect(decodePairingCreateResult(created)).toEqual({ ok: true, value: created });
    expect(decodePairingClaimResult(claimed)).toEqual({ ok: true, value: claimed });
    expect(decodePairingOwnerResult(owner)).toEqual({ ok: true, value: owner });
    expect(decodePairingDecisionResult(owner)).toEqual({ ok: true, value: owner });
  });

  it.each([
    ['create', decodePairingCreateResult, { ...created, internal: 'secret' }],
    ['claim', decodePairingClaimResult, { ...claimed, ownerId: 'owner_secret' }],
    ['owner', decodePairingOwnerResult, { ...owner, receipt: digest }],
    ['decision', decodePairingDecisionResult, { ...owner, revision: 'r2', providerRevision: 'secret' }],
  ] as const)('rejects unknown fields from a %s result', (_name, decode, input) => {
    expect(decode(input)).toEqual(expect.objectContaining({ ok: false }));
  });

  it.each([
    ['create', decodePairingCreateResult, created],
    ['claim', decodePairingClaimResult, claimed],
    ['owner', decodePairingOwnerResult, owner],
    ['decision', decodePairingDecisionResult, owner],
  ] as const)('rejects unsupported versions from a %s result', (_name, decode, input) => {
    expect(decode({ ...input, v: 2 })).toEqual({ ok: false, error: { path: 'v', code: 'unsupported_version' } });
  });

  it('requires the owner result revision while the projection remains revision-free', () => {
    expect(decodePairingOwnerResult(projection)).toEqual({ ok: false, error: { path: 'revision', code: 'missing_field' } });
    expect(decodePairingOwnerProjection(owner)).toEqual({ ok: false, error: { path: 'revision', code: 'unknown_field' } });
  });
});

describe('safe owner projection', () => {
  it('round-trips every valid lifecycle shape', () => {
    const issued = { ...projection, state: 'issued', claim: null };
    const decided = { ...projection, state: 'approved', decidedAt: '2026-09-24T12:01:00.123Z' };
    const expired = { ...projection, state: 'expired' };
    for (const input of [issued, projection, decided, { ...decided, state: 'denied' }, expired]) {
      expect(decodePairingOwnerProjection(input)).toEqual({ ok: true, value: input });
    }
  });

  it.each([
    ['issued with a claim', { ...projection, state: 'issued' }, 'claim'],
    ['claimed with a decision time', { ...projection, decidedAt: '2026-09-24T12:01:00Z' }, 'decidedAt'],
    ['approved without a claim', { ...projection, state: 'approved', claim: null, decidedAt: '2026-09-24T12:01:00Z' }, 'claim'],
    ['approved without a decision time', { ...projection, state: 'approved' }, 'decidedAt'],
  ])('rejects invalid state combination: %s', (_name, input, path) => {
    expect(decodePairingOwnerProjection(input)).toEqual({ ok: false, error: { path, code: 'mismatch' } });
  });

  it('rejects malformed and reversed timestamps', () => {
    expect(decodePairingOwnerProjection({ ...projection, expiresAt: '2026-02-30T12:05:00Z' })).toEqual({
      ok: false, error: { path: 'expiresAt', code: 'invalid_value' },
    });
    expect(decodePairingOwnerProjection({ ...projection, expiresAt: projection.createdAt })).toEqual({
      ok: false, error: { path: 'expiresAt', code: 'invalid_value' },
    });
  });

  it.each(['code', 'receipt', 'grant', 'proof', 'cookie', 'authorization'])('cannot represent secret field %s', field => {
    expect(decodePairingOwnerProjection({ ...projection, [field]: 'secret' })).toEqual({
      ok: false, error: { path: field, code: 'unknown_field' },
    });
  });

  it('labels claim evidence as connector-inspected rather than server-attested', () => {
    expect(decodePairingOwnerProjection({ ...projection, claim: { ...claimView, verification: 'server_attested' } })).toEqual({
      ok: false, error: { path: 'claim.verification', code: 'invalid_value' },
    });
  });
});

describe('approval result and finite failure matrix', () => {
  it('round-trips all approval result states', () => {
    for (const input of [
      { v: 1, state: 'pending' },
      { v: 1, state: 'denied', decidedAt: '2026-09-24T12:01:00Z' },
      { v: 1, state: 'expired' },
      { v: 1, state: 'approved', grant: digest, expiresAt: '2026-09-24T12:02:00Z' },
    ]) expect(decodePairingApprovalResult(input)).toEqual({ ok: true, value: input });
  });

  it('rejects state fields from another result variant', () => {
    expect(decodePairingApprovalResult({ v: 1, state: 'pending', grant: digest })).toEqual({
      ok: false, error: { path: 'grant', code: 'unknown_field' },
    });
  });

  it('pins the complete fixed public failure matrix', () => {
    expect(PAIRING_FAILURE_CODES).toEqual({
      create: ['invalid_request', 'signed_out', 'forbidden', 'conflict', 'feature_unavailable', 'unavailable'],
      claim: ['invalid_request', 'claim_refused', 'rate_limited', 'invalid_proof', 'feature_unavailable', 'unavailable'],
      inspect: ['signed_out', 'forbidden', 'not_found', 'feature_unavailable', 'unavailable'],
      decide: [
        'invalid_request', 'signed_out', 'forbidden', 'stale_claim', 'decision_conflict', 'expired', 'feature_unavailable', 'unavailable',
      ],
      result: ['invalid_request', 'invalid_receipt', 'invalid_proof', 'feature_unavailable', 'unavailable'],
      redeem: ['invalid_grant', 'invalid_proof', 'unavailable'],
    });
    for (const [route, codes] of Object.entries(PAIRING_FAILURE_CODES)) {
      for (const code of codes) {
        const body = { v: 1, kind: 'rejected', code };
        expect(decodePairingFailure(route as keyof typeof PAIRING_FAILURE_CODES, body)).toEqual({ ok: true, value: body });
      }
    }
    expect(decodePairingFailure('claim', { v: 1, kind: 'rejected', code: 'not_found' })).toEqual({
      ok: false, error: { path: 'code', code: 'invalid_value' },
    });
  });
});
