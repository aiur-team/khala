// Transport-level tests for `pairing-code-v1`. The control service is a fake
// transport; the proof signer is real so DPoP targets and key binding are checked.

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type HarnessCapabilities, unknownModeSupportMap } from '@khala/contracts/delivery/index';
import { PAIRING_CLAIM_PATH, PAIRING_RESULT_PATH, REDEEM_PATH, type PairingDescriptor } from './descriptor';
import { createPairingOwnership, sessionEvidenceDigest } from './pairing';
import { createProofSigner } from './proof';

const ORIGIN = 'https://khala.example';
const T0 = Date.parse('2026-09-25T12:00:00Z');
const CODE = '7K3QX-9MZ2P';
const HANDLE = `pair_${'h'.repeat(43)}`;
const RECEIPT = 'r'.repeat(43);
const GRANT = 'g'.repeat(43);
const EVIDENCE = 'e'.repeat(43);
const SESSION = { harness: 'codex', sessionId: 'thread-existing-b', generation: 3 };
const DESCRIPTOR: PairingDescriptor = {
  v: 1, claim: `${ORIGIN}${PAIRING_CLAIM_PATH}`, result: `${ORIGIN}${PAIRING_RESULT_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`, id: 'descriptor-id',
};
const CLAIM = {
  code: CODE, descriptor: DESCRIPTOR, session: SESSION, evidenceDigest: EVIDENCE, deviceId: 'KHALADEV1', operationId: 'pairing-op-1',
};

type Reply = Readonly<{ status: number; body?: unknown; contentType?: string }> | 'network';

function json(status: number, body: unknown): Reply {
  return { status, body };
}
const rejected = (status: number, code: string) => json(status, { v: 1, kind: 'rejected', code });
const claimed = json(200, { v: 1, state: 'pending', requestHandle: HANDLE, receipt: RECEIPT });
const pending = json(200, { v: 1, state: 'pending' });
const approved = (expiresAt = new Date(T0 + 60_000).toISOString()) => json(200, { v: 1, state: 'approved', grant: GRANT, expiresAt });

function control(...replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected request');
    if (reply === 'network') throw new TypeError(`fetch failed for ${String(url)} with ${CODE}`);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { 'content-type': reply.contentType ?? 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function setup(replies: Reply[], options: { timeoutMs?: number } = {}) {
  const { privateKey } = generateKeyPairSync('ed25519');
  let now = T0;
  const signer = createProofSigner(privateKey, () => now);
  const { fetchImpl, calls } = control(...replies);
  const waits: number[] = [];
  const pairing = createPairingOwnership({
    signer,
    fetch: fetchImpl,
    clock: () => now,
    pollIntervalMs: 2_000,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    wait: async ms => { waits.push(ms); now += ms; },
  });
  return { pairing, calls, waits, signer };
}

function proofClaims(proof: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString());
}

describe('createPairingOwnership', () => {
  it('AE2: claims with the key, device and inspected session, waits through pending, and returns the bound grant', async () => {
    const { pairing, calls, waits, signer } = setup([claimed, pending, pending, approved()]);
    const outcome = await pairing.claim(CLAIM);

    expect(outcome).toEqual({
      kind: 'granted',
      grant: {
        method: 'pairing-code-v1', redeem: DESCRIPTOR.redeem, session: SESSION, deviceId: 'KHALADEV1', expiresAt: T0 + 60_000, secret: GRANT,
      },
    });
    expect(calls[0]!.url).toBe(DESCRIPTOR.claim);
    expect(calls[0]!.body).toEqual({
      v: 1, code: CODE, operationId: 'pairing-op-1', jkt: signer.jkt,
      harness: 'codex', sessionId: 'thread-existing-b', generation: 3, deviceId: 'KHALADEV1', evidenceDigest: EVIDENCE,
    });
    for (const call of calls.slice(1)) {
      expect(call.url).toBe(DESCRIPTOR.result);
      expect(call.body).toEqual({ v: 1, requestHandle: HANDLE, receipt: RECEIPT, operationId: 'pairing-op-1', jkt: signer.jkt });
    }
    // Each request carries a fresh proof for exactly its own method and URL.
    const proofs = calls.map(call => proofClaims(call.headers.dpop!));
    expect(proofs.map(proof => [proof.htm, proof.htu])).toEqual([
      ['POST', DESCRIPTOR.claim], ['POST', DESCRIPTOR.result], ['POST', DESCRIPTOR.result], ['POST', DESCRIPTOR.result],
    ]);
    expect(new Set(proofs.map(proof => proof.jti)).size).toBe(4);
    expect(waits).toEqual([2_000, 2_000]);
  });

  it('returns denial and expiry as finite refusals', async () => {
    expect(await setup([claimed, json(200, { v: 1, state: 'denied', decidedAt: new Date(T0).toISOString() })]).pairing.claim(CLAIM))
      .toEqual({ kind: 'refused', code: 'pairing_denied' });
    expect(await setup([claimed, json(200, { v: 1, state: 'expired' })]).pairing.claim(CLAIM))
      .toEqual({ kind: 'refused', code: 'pairing_expired' });
    // An approval whose grant is already past its expiry is expiry, not a grant.
    expect(await setup([claimed, approved(new Date(T0).toISOString())]).pairing.claim(CLAIM))
      .toEqual({ kind: 'refused', code: 'pairing_expired' });
  });

  it('AE6: invalid, expired, used and foreign codes are one non-enumerating refusal with no request after the claim', async () => {
    for (const reply of [rejected(400, 'claim_refused'), rejected(400, 'invalid_request')]) {
      const { pairing, calls } = setup([reply]);
      const outcome = await pairing.claim(CLAIM);
      expect(outcome).toEqual({ kind: 'refused', code: 'pairing_refused' });
      expect(JSON.stringify(outcome)).not.toMatch(/channel|owner|binding|receipt|grant/i);
      expect(calls).toHaveLength(1);
    }
  });

  it('maps rate limiting, bad proofs and service outages to finite outcomes', async () => {
    expect(await setup([rejected(429, 'rate_limited')]).pairing.claim(CLAIM)).toEqual({ kind: 'refused', code: 'rate_limited' });
    expect(await setup([rejected(401, 'invalid_proof')]).pairing.claim(CLAIM)).toEqual({ kind: 'refused', code: 'ownership_required' });
    expect(await setup([rejected(503, 'unavailable')]).pairing.claim(CLAIM)).toEqual({ kind: 'unavailable' });
    expect(await setup(['network']).pairing.claim(CLAIM)).toEqual({ kind: 'unavailable' });
    expect(await setup([claimed, rejected(400, 'invalid_receipt')]).pairing.claim(CLAIM)).toEqual({ kind: 'refused', code: 'pairing_refused' });
  });

  it('refuses malformed, oversized and wrong-media responses without echoing them', async () => {
    const bad: Reply[] = [
      json(200, { v: 1, state: 'pending', requestHandle: HANDLE, receipt: RECEIPT, channelId: 'room-1' }),
      { status: 200, body: JSON.stringify({ v: 1, state: 'pending', requestHandle: HANDLE, receipt: RECEIPT }), contentType: 'text/plain' },
      { status: 200, body: `"${'x'.repeat(5000)}"` },
    ];
    for (const reply of bad) expect(await setup([reply]).pairing.claim(CLAIM)).toEqual({ kind: 'unavailable' });
    expect(await setup([claimed, json(200, { v: 1, state: 'approved', grant: GRANT })]).pairing.claim(CLAIM)).toEqual({ kind: 'unavailable' });
  });

  it('keeps waiting through transient result failures until the deadline', async () => {
    const { pairing, calls } = setup([claimed, 'network', rejected(503, 'unavailable'), json(429, null), approved()]);
    expect(await pairing.claim(CLAIM)).toMatchObject({ kind: 'granted' });
    expect(calls).toHaveLength(5);
  });

  it('stops at the deadline with a resumable pending result', async () => {
    const replies: Reply[] = [claimed, ...Array.from({ length: 10 }, () => pending)];
    const { pairing, calls } = setup(replies, { timeoutMs: 5_000 });
    expect(await pairing.claim(CLAIM)).toEqual({ kind: 'pending', reason: 'approval_timeout' });
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it('stops on cancellation with a resumable pending result', async () => {
    const controller = new AbortController();
    const { pairing } = setup([claimed, pending, pending]);
    const outcome = pairing.claim({ ...CLAIM, signal: controller.signal });
    controller.abort();
    expect(await outcome).toEqual({ kind: 'pending', reason: 'cancelled' });

    const aborted = new AbortController();
    aborted.abort();
    const idle = setup([]);
    expect(await idle.pairing.claim({ ...CLAIM, signal: aborted.signal })).toEqual({ kind: 'pending', reason: 'cancelled' });
    expect(idle.calls).toHaveLength(0);
  });

  it('AE3: repeating the same claim after a lost approval reuses the same request', async () => {
    const { pairing, calls } = setup([claimed, 'network', claimed, approved()], { timeoutMs: 2_000 });
    // First attempt: the approval response is lost and the wait ends.
    expect(await pairing.claim(CLAIM)).toEqual({ kind: 'pending', reason: 'approval_timeout' });
    // Second attempt: identical claim, then the approved result.
    expect(await pairing.claim(CLAIM)).toMatchObject({ kind: 'granted' });
    expect(calls[2]!.body).toEqual(calls[0]!.body);
  });
});

describe('sessionEvidenceDigest', () => {
  const capabilities: HarnessCapabilities = {
    v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1', support: 'tested', existingSession: 'khala_hosted_resume',
    immediateNotification: 'khala_hosted_idle', busy: 'queue', receiptEvidence: [], reconcileByReleaseId: 'unknown',
    limits: { maxPayloadBytes: 1024, maxBatchItems: 1 } as never, evidenceRef: 'docs/evidence/codex.md',
    modes: unknownModeSupportMap('test-codex-interactive', 'Test fixture has no primary mode proof.', '1.0.0'),
    acknowledgement: 'unknown',
  };

  it('is a stable 256-bit digest that changes with the generation or the verifying adapter', () => {
    const digest = sessionEvidenceDigest(SESSION, capabilities);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionEvidenceDigest(SESSION, capabilities)).toBe(digest);
    expect(sessionEvidenceDigest({ ...SESSION, generation: 4 }, capabilities)).not.toBe(digest);
    expect(sessionEvidenceDigest(SESSION, { ...capabilities, adapterVersion: '2' })).not.toBe(digest);
  });
});
