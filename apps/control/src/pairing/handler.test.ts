import { generateKeyPairSync, randomBytes, sign, createPublicKey } from 'node:crypto';
import {
  decodePairingClaimResult,
  decodePairingCreateResult,
  decodePairingDecisionResult,
  decodePairingOwnerResult,
  type AuthPrincipal,
  type DeviceId,
  type OwnerId,
  type RoomId,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { thumbprint } from '../agent-bootstrap/proof';
import type { Authentication, MutationAuthorization } from '../auth';
import { fakeStore, T0 } from '../auth/support.test';
import { createPairingPolicy, type PairingAttemptLimiter } from './policy';
import { createPairingStore, type PairingStore } from './store';
import {
  AGENT_PAIRING_CLAIM_PATH,
  AGENT_PAIRING_RESULT_PATH,
  HUMAN_PAIRING_DECISION_PATH,
  HUMAN_PAIRING_REQUEST_PATH,
  createPairingHandlers,
  type PairingHandlerDependencies,
} from './handler';

const ORIGIN = 'https://khala.example';
const OWNER = 'owner_1' as OwnerId;
const CHANNEL = 'room_1' as RoomId;
const DIGEST = 'e'.repeat(43);

function principal(ownerId = OWNER): AuthPrincipal {
  return {
    v: 1, ownerId, providerIssuer: 'https://id.example', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-24T13:00:00Z',
  };
}

function connectorKey(clock = () => T0) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  const jkt = thumbprint(x);
  return {
    jkt,
    proof(url: string, claims: Record<string, unknown> = {}) {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x } })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        htm: 'POST', htu: url, iat: Math.floor(clock() / 1000), jti: randomBytes(16).toString('base64url'), ...claims,
      })).toString('base64url');
      return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    },
  };
}

function stubStore(overrides: Partial<PairingStore> = {}): PairingStore {
  return {
    create: async () => ({ kind: 'created', code: '01234-56789', requestHandle: `pair_${DIGEST}`, expiresAt: '2026-09-24T12:05:00Z' }),
    claim: async () => ({ kind: 'claimed', requestHandle: `pair_${DIGEST}`, receipt: DIGEST }),
    inspect: async () => ({ kind: 'not_found' }),
    decide: async () => ({ kind: 'not_found' }),
    result: async () => ({ kind: 'result', value: { v: 1, state: 'pending' } }),
    claimProofReplay: async () => ({ kind: 'claimed' }),
    grantPort: { redeem: async () => ({ kind: 'invalid_grant' }), markIssued: async () => 'replayed' },
    ...overrides,
  };
}

function dependencies(overrides: Partial<PairingHandlerDependencies> = {}): PairingHandlerDependencies {
  const policy = createPairingPolicy({ v: 1, activeKeyId: 'k1', keys: [{ id: 'k1', key: new Uint8Array(32).fill(7) }] });
  const authenticated = { kind: 'authenticated', context: { principal: principal(), csrfToken: 'csrf' } } as const;
  return {
    origin: ORIGIN,
    clock: () => T0,
    store: stubStore(),
    policy,
    limiter: {
      reserve: async () => ({ kind: 'reserved', permit: { permitId: 'permit_1', leaseExpiresAt: '2026-09-24T12:05:00Z' } }),
      finalize: async input => input.disposition === 'release' ? { kind: 'released' } : { kind: 'finalized' },
    },
    trustedSource: async () => ({ kind: 'trusted', source: 'platform:203.0.113.7' }),
    auth: {
      authenticateRequest: async (): Promise<Authentication> => authenticated,
      requireHumanMutation: async (): Promise<MutationAuthorization> => ({ kind: 'authorized', context: authenticated.context }),
    },
    authorizeTarget: async () => ({ kind: 'allowed', origin: ORIGIN, descriptorId: 'descriptor_v1' }),
    ...overrides,
  };
}

function route(deps: PairingHandlerDependencies, path: string) {
  const handlers = createPairingHandlers(deps);
  return [...handlers.human, ...handlers.agent].find(candidate => candidate.path === path)!;
}

function post(deps: PairingHandlerDependencies, path: string, body: unknown, headers: Record<string, string> = {}) {
  return route(deps, path).handle(new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body),
  }));
}

const createBody = { v: 1, channelId: CHANNEL, origin: ORIGIN, descriptorId: 'descriptor_v1', operationId: 'create_1' };
const claimBody = (jkt: string) => ({
  v: 1, code: '01234-56789', operationId: 'claim_1', jkt, harness: 'codex', sessionId: 'thread_1', generation: 1,
  deviceId: 'device_1' as DeviceId, evidenceDigest: DIGEST,
});

describe('pairing route surface and human authority', () => {
  it('exports only the five route/method pairs and the internal grant port', () => {
    const handlers = createPairingHandlers(dependencies());
    expect([...handlers.human, ...handlers.agent].map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: HUMAN_PAIRING_REQUEST_PATH, methods: ['POST', 'GET'] },
      { path: HUMAN_PAIRING_DECISION_PATH, methods: ['POST'] },
      { path: AGENT_PAIRING_CLAIM_PATH, methods: ['POST'] },
      { path: AGENT_PAIRING_RESULT_PATH, methods: ['POST'] },
    ]);
    expect(handlers.grantPort).toBeDefined();
    expect(JSON.stringify([...handlers.human, ...handlers.agent])).not.toContain('redeem');
  });

  it('builds creates from authenticated owner and trusted target only', async () => {
    let received: unknown;
    const deps = dependencies({ store: stubStore({ create: async input => {
      received = input;
      return { kind: 'created', code: '01234-56789', requestHandle: `pair_${DIGEST}`, expiresAt: '2026-09-24T12:05:00Z' };
    } }) });
    const response = await post(deps, HUMAN_PAIRING_REQUEST_PATH, createBody);
    expect(response.status).toBe(201);
    expect(received).toEqual({ ownerId: OWNER, channelId: CHANNEL, origin: ORIGIN, descriptorId: 'descriptor_v1', operationId: 'create_1' });
    const body = await response.json();
    expect(decodePairingCreateResult(body)).toEqual({ ok: true, value: body });
    expect(body).toEqual({
      v: 1, state: 'issued', code: '01234-56789', requestHandle: `pair_${DIGEST}`, expiresAt: '2026-09-24T12:05:00Z',
    });
  });

  it('rejects client target mismatches before store creation', async () => {
    let creates = 0;
    const deps = dependencies({ store: stubStore({ create: async () => { creates += 1; return { kind: 'unavailable' }; } }) });
    for (const body of [{ ...createBody, origin: 'https://evil.example' }, { ...createBody, descriptorId: 'other_descriptor' }]) {
      const response = await post(deps, HUMAN_PAIRING_REQUEST_PATH, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'forbidden' });
    }
    expect(creates).toBe(0);
  });

  it.each(['unavailable', 'throw'] as const)('fails closed when target authorization is %s', async fault => {
    let creates = 0;
    const deps = dependencies({
      authorizeTarget: async () => {
        if (fault === 'throw') throw new Error('descriptor secret');
        return { kind: 'unavailable' };
      },
      store: stubStore({ create: async () => { creates += 1; return { kind: 'unavailable' }; } }),
    });
    const response = await post(deps, HUMAN_PAIRING_REQUEST_PATH, createBody);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'unavailable' });
    expect(creates).toBe(0);
  });

  it.each([
    ['signed out', { kind: 'rejected', code: 'signed_out' } as const, 401, 'signed_out'],
    ['missing csrf', { kind: 'rejected', code: 'csrf_mismatch' } as const, 403, 'forbidden'],
    ['wrong origin', { kind: 'rejected', code: 'forbidden_origin' } as const, 403, 'forbidden'],
  ])('maps %s mutation refusal to the finite route vocabulary', async (_name, auth, status, code) => {
    const base = dependencies();
    const response = await post(dependencies({ auth: { ...base.auth, requireHumanMutation: async () => auth } }), HUMAN_PAIRING_REQUEST_PATH, createBody);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code });
  });

  it('uses the authenticated owner for inspect and decision and maps cross-owner/stale outcomes', async () => {
    const deps = dependencies({ store: stubStore({
      inspect: async ({ ownerId }) => ownerId === OWNER ? { kind: 'forbidden' } : { kind: 'not_found' },
      decide: async () => ({ kind: 'stale' }),
    }) });
    const inspected = await route(deps, HUMAN_PAIRING_REQUEST_PATH).handle(new Request(`${ORIGIN}${HUMAN_PAIRING_REQUEST_PATH}?request_id=pair_${DIGEST}`));
    expect(inspected.status).toBe(403);
    expect(await inspected.json()).toEqual({ v: 1, kind: 'rejected', code: 'forbidden' });
    const decided = await post(deps, HUMAN_PAIRING_DECISION_PATH, {
      v: 1, requestHandle: `pair_${DIGEST}`, revision: 'r1', claimFingerprint: DIGEST, decision: 'approve', operationId: 'decision_1',
    });
    expect(decided.status).toBe(409);
    expect(await decided.json()).toEqual({ v: 1, kind: 'rejected', code: 'stale_claim' });
    const crossOwner = await post(dependencies({ store: stubStore({ decide: async () => ({ kind: 'forbidden' }) }) }),
      HUMAN_PAIRING_DECISION_PATH, {
        v: 1, requestHandle: `pair_${DIGEST}`, revision: 'r1', claimFingerprint: DIGEST,
        decision: 'approve', operationId: 'decision_1',
      });
    expect(crossOwner.status).toBe(403);
    expect(await crossOwner.json()).toEqual({ v: 1, kind: 'rejected', code: 'forbidden' });
  });

  it('rejects malformed, unknown-field, and unsupported-version JSON without calling a store', async () => {
    let calls = 0;
    const deps = dependencies({ store: stubStore({ create: async () => { calls += 1; return { kind: 'unavailable' }; } }) });
    for (const body of [{ ...createBody, v: 2 }, { ...createBody, extra: true }]) {
      const response = await post(deps, HUMAN_PAIRING_REQUEST_PATH, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'invalid_request' });
    }
    const invalidJson = await route(deps, HUMAN_PAIRING_REQUEST_PATH).handle(new Request(`${ORIGIN}${HUMAN_PAIRING_REQUEST_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }));
    expect(invalidJson.status).toBe(400);
    expect(calls).toBe(0);
  });
});

describe('agent proof, replay, limiter, and finite failures', () => {
  it('validates proof and replay before reserving, then releases a winning claim permit', async () => {
    const key = connectorKey();
    const events: string[] = [];
    const deps = dependencies({
      store: stubStore({
        claimProofReplay: async () => { events.push('replay'); return { kind: 'claimed' }; },
        claim: async () => { events.push('claim'); return { kind: 'claimed', requestHandle: `pair_${DIGEST}`, receipt: DIGEST }; },
      }),
      trustedSource: async () => { events.push('source'); return { kind: 'trusted', source: 'edge-source' }; },
      limiter: {
        reserve: async () => { events.push('reserve'); return { kind: 'reserved', permit: { permitId: 'p1', leaseExpiresAt: '2026-09-24T12:05:00Z' } }; },
        finalize: async input => { events.push(`finalize:${input.disposition}`); return { kind: 'released' }; },
      },
    });
    const response = await post(deps, AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
    expect(response.status).toBe(200);
    expect(events).toEqual(['replay', 'source', 'reserve', 'claim', 'finalize:release']);
    const body = await response.json();
    expect(decodePairingClaimResult(body)).toEqual({ ok: true, value: body });
    expect(body).toEqual({ v: 1, state: 'pending', requestHandle: `pair_${DIGEST}`, receipt: DIGEST });
  });

  it('maps wrong-target and replayed proofs without reading pairing state', async () => {
    const key = connectorKey();
    let claims = 0;
    const wrong = await post(dependencies({ store: stubStore({ claim: async () => { claims += 1; return { kind: 'unavailable' }; } }) }),
      AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}/api/agent/pairing/other`) });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ v: 1, kind: 'rejected', code: 'invalid_proof' });
    const replayed = await post(dependencies({ store: stubStore({
      claimProofReplay: async () => ({ kind: 'replayed' }), claim: async () => { claims += 1; return { kind: 'unavailable' }; },
    }) }), AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
    expect(replayed.status).toBe(401);
    expect(claims).toBe(0);
  });

  it.each(['reserve-unavailable', 'reserve-throw'] as const)('fails closed on limiter %s before claim lookup', async fault => {
    const key = connectorKey();
    let claims = 0;
    const limiter: PairingAttemptLimiter = {
      reserve: async () => {
        if (fault === 'reserve-throw') throw new Error('authorization=secret');
        return { kind: 'unavailable' };
      },
      finalize: async () => ({ kind: 'finalized' }),
    };
    const response = await post(dependencies({ limiter, store: stubStore({ claim: async () => { claims += 1; return { kind: 'unavailable' }; } }) }),
      AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'unavailable' });
    expect(claims).toBe(0);
  });

  it.each(['unavailable', 'throw'] as const)('returns unavailable when finalization is %s even after a claim applied', async fault => {
    const key = connectorKey();
    const base = dependencies();
    const response = await post(dependencies({ limiter: {
      ...base.limiter,
      finalize: async () => {
        if (fault === 'throw') throw new Error('permit provider authorization=secret');
        return { kind: 'unavailable' };
      },
    } }), AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'unavailable' });
  });

  it.each([
    ['release', 'finalized', { kind: 'claimed', requestHandle: `pair_${DIGEST}`, receipt: DIGEST }],
    ['failure', 'released', { kind: 'refused' }],
  ] as const)('fails closed when %s finalization reports %s', async (_disposition, providerKind, claimOutcome) => {
    const key = connectorKey();
    const base = dependencies();
    const response = await post(dependencies({
      store: stubStore({ claim: async () => claimOutcome }),
      limiter: {
        ...base.limiter,
        finalize: async () => providerKind === 'released' ? { kind: 'released' } : { kind: 'finalized' },
      },
    }), AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'unavailable' });
  });

  it('derives the source bucket only from the injected trusted platform boundary', async () => {
    const key = connectorKey();
    let bucketInput: unknown;
    const deps = dependencies({
      trustedSource: async request => {
        expect(request.headers.get('x-forwarded-for')).toBe('198.51.100.99');
        return { kind: 'trusted', source: 'netlify:trusted-source' };
      },
      policy: {
        attemptBuckets(input) {
          bucketInput = input;
          return { sourceBucket: 'source', codeBucket: 'code' };
        },
      },
    });
    const response = await post(deps, AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), {
      dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`),
      'x-forwarded-for': '198.51.100.99',
    });
    expect(response.status).toBe(200);
    expect(bucketInput).toEqual({ trustedSource: 'netlify:trusted-source', code: '01234-56789', operationId: 'claim_1' });
  });

  it('makes absent, expired, used, and different-claim refusals observationally identical', async () => {
    const key = connectorKey();
    for (const reason of ['absent', 'expired', 'used', 'different']) {
      const response = await post(dependencies({ store: stubStore({ claim: async () => ({ kind: 'refused' }) }) }),
        AGENT_PAIRING_CLAIM_PATH, { ...claimBody(key.jkt), operationId: `claim_${reason}` },
        { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 400, body: { v: 1, kind: 'rejected', code: 'claim_refused' },
      });
    }
  });

  it('charges refused claims as failures and maps an atomic reservation limit without store lookup', async () => {
    const key = connectorKey();
    let disposition: string | undefined;
    const base = dependencies();
    const refused = await post(dependencies({
      store: stubStore({ claim: async () => ({ kind: 'refused' }) }),
      limiter: {
        ...base.limiter,
        finalize: async input => { disposition = input.disposition; return { kind: 'finalized' }; },
      },
    }), AGENT_PAIRING_CLAIM_PATH, claimBody(key.jkt), { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
    expect(refused.status).toBe(400);
    expect(disposition).toBe('failure');

    let claims = 0;
    const limited = await post(dependencies({
      limiter: { ...base.limiter, reserve: async () => ({ kind: 'limited' }) },
      store: stubStore({ claim: async () => { claims += 1; return { kind: 'unavailable' }; } }),
    }), AGENT_PAIRING_CLAIM_PATH, { ...claimBody(key.jkt), operationId: 'claim_limited' }, {
      dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`),
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ v: 1, kind: 'rejected', code: 'rate_limited' });
    expect(claims).toBe(0);
  });

  it('requires the result key in the strict body and proof, and maps random receipts uniformly', async () => {
    const key = connectorKey();
    const other = connectorKey();
    const body = { v: 1, requestHandle: `pair_${DIGEST}`, receipt: DIGEST, operationId: 'result_1', jkt: key.jkt };
    const malformed = await post(dependencies(), AGENT_PAIRING_RESULT_PATH, { ...body, jkt: undefined }, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    expect(malformed.status).toBe(400);
    const wrongKey = await post(dependencies(), AGENT_PAIRING_RESULT_PATH, body, { dpop: other.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    expect(wrongKey.status).toBe(401);
    const randomReceipt = await post(dependencies({ store: stubStore({ result: async () => ({ kind: 'invalid' }) }) }),
      AGENT_PAIRING_RESULT_PATH, body, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    expect(randomReceipt.status).toBe(400);
    expect(await randomReceipt.json()).toEqual({ v: 1, kind: 'rejected', code: 'invalid_receipt' });
  });

  it('claims result proof replay before store lookup and rejects ath-bearing proofs', async () => {
    const key = connectorKey();
    let results = 0;
    const body = { v: 1, requestHandle: `pair_${DIGEST}`, receipt: DIGEST, operationId: 'result_1', jkt: key.jkt };
    const replayed = await post(dependencies({ store: stubStore({
      claimProofReplay: async () => ({ kind: 'replayed' }),
      result: async () => { results += 1; return { kind: 'unavailable' }; },
    }) }), AGENT_PAIRING_RESULT_PATH, body, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    expect(replayed.status).toBe(401);
    const ath = await post(dependencies({ store: stubStore({ result: async () => { results += 1; return { kind: 'unavailable' }; } }) }),
      AGENT_PAIRING_RESULT_PATH, body, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`, { ath: DIGEST }) });
    expect(ath.status).toBe(401);
    expect(results).toBe(0);
  });
});

describe('real PairingStore route chain', () => {
  it('keeps a valid claim pending until exact owner approval, then only the winning receipt/key recovers the grant', async () => {
    let now = T0;
    let randomFill = 0;
    const backing = fakeStore(() => now);
    const policy = createPairingPolicy({ v: 1, activeKeyId: 'k1', keys: [{ id: 'k1', key: new Uint8Array(32).fill(9) }] });
    const store = createPairingStore({
      store: backing.store, policy, clock: () => now,
      random: bytes => new Uint8Array(bytes).fill((randomFill += 1)),
    });
    const deps = dependencies({ store, policy, clock: () => now });
    const key = connectorKey(() => now);
    const createdResponse = await post(deps, HUMAN_PAIRING_REQUEST_PATH, createBody);
    const created = await createdResponse.json() as { code: string; requestHandle: string };
    const claimedResponse = await post(deps, AGENT_PAIRING_CLAIM_PATH, { ...claimBody(key.jkt), code: created.code }, {
      dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`),
    });
    const claimed = await claimedResponse.json() as { receipt: string };
    const pending = await post(deps, AGENT_PAIRING_RESULT_PATH, {
      v: 1, requestHandle: created.requestHandle, receipt: claimed.receipt, operationId: 'claim_1', jkt: key.jkt,
    }, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    expect(await pending.json()).toEqual({ v: 1, state: 'pending' });

    const inspectedResponse = await route(deps, HUMAN_PAIRING_REQUEST_PATH).handle(
      new Request(`${ORIGIN}${HUMAN_PAIRING_REQUEST_PATH}?request_id=${created.requestHandle}`),
    );
    const inspected = await inspectedResponse.json() as { revision: string; claim: { fingerprint: string } };
    expect(decodePairingOwnerResult(inspected)).toEqual({ ok: true, value: inspected });
    const approved = await post(deps, HUMAN_PAIRING_DECISION_PATH, {
      v: 1, requestHandle: created.requestHandle, revision: inspected.revision, claimFingerprint: inspected.claim.fingerprint,
      decision: 'approve', operationId: 'decision_1',
    });
    expect(approved.status).toBe(200);
    const approvedBody = await approved.clone().json();
    expect(decodePairingDecisionResult(approvedBody)).toEqual({ ok: true, value: approvedBody });
    now += 1;
    const result = await post(deps, AGENT_PAIRING_RESULT_PATH, {
      v: 1, requestHandle: created.requestHandle, receipt: claimed.receipt, operationId: 'claim_1', jkt: key.jkt,
    }, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    expect(await result.json()).toMatchObject({ v: 1, state: 'approved', grant: expect.any(String) });

    const thief = connectorKey(() => now);
    for (const body of [
      { v: 1, requestHandle: created.requestHandle, receipt: 'r'.repeat(43), operationId: 'claim_1', jkt: key.jkt },
      { v: 1, requestHandle: created.requestHandle, receipt: claimed.receipt, operationId: 'claim_1', jkt: thief.jkt },
      { v: 1, requestHandle: created.requestHandle, receipt: claimed.receipt, operationId: 'other_result', jkt: key.jkt },
    ]) {
      const signer = body.jkt === thief.jkt ? thief : key;
      const refused = await post(deps, AGENT_PAIRING_RESULT_PATH, body, { dpop: signer.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ v: 1, kind: 'rejected', code: 'invalid_receipt' });
    }
  });
});
