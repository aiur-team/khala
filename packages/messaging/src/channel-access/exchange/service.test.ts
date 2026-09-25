import {
  type OperationResult,
  type SealedGrantEnvelope,
  decodeSealedGrantPayload,
  validateSealedGrantPayload,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS, CHANNEL_ACCESS_GRANT_LIFETIME_MS, createGrantExchangeService } from './service';
import {
  CHANNEL,
  DEADLINE,
  DEVICE,
  FINGERPRINT,
  ORIGIN,
  OWNER,
  REQUESTER,
  T0,
  authorization,
  connectorKeys,
  fakeAuthority,
  fakeControlStore,
  fakeIssuer,
  fakeProvider,
  openEnvelope,
  validatedRequest,
} from './support.test';

async function harness() {
  let now = T0;
  const backing = fakeControlStore();
  backing.useClock(() => now);
  const authority = fakeAuthority();
  const provider = fakeProvider();
  const issuer = fakeIssuer();
  const service = createGrantExchangeService({
    store: backing.store,
    authority: authority.port,
    provider: provider.port,
    issuer: issuer.port,
    clock: () => now,
  });
  const keys = await connectorKeys();
  const port = service.forConnector({ sessionFingerprint: FINGERPRINT });
  return {
    backing,
    authority,
    provider,
    issuer,
    service,
    keys,
    port,
    request: () => validatedRequest(keys, {}, now),
    exchange: async () => port.exchange(await validatedRequest(keys, {}, now)),
    setNow(value: number) { now = value; },
  };
}

function envelopeOf(result: OperationResult<SealedGrantEnvelope, string>): SealedGrantEnvelope {
  if (result.kind !== 'ok') throw new Error(`expected an envelope, got ${JSON.stringify(result)}`);
  return result.value;
}

describe('channel-access grant exchange', () => {
  it('admits once with history none and returns one sealed, context-bound grant', async () => {
    const h = await harness();
    const envelope = envelopeOf(await h.exchange());

    expect(h.provider.admits).toHaveLength(1);
    expect(h.provider.admits[0]).toMatchObject({
      ownerId: OWNER, channelRef: CHANNEL, requester: REQUESTER, deviceId: DEVICE, sessionGeneration: 3, history: 'none',
    });
    expect(h.provider.admits[0]!.providerOperationId).toMatch(/^caadmit_[0-9a-f]{64}$/);
    expect(h.issuer.minted).toHaveLength(1);
    expect(h.issuer.bindings[0]).toEqual({
      binding: {
        operationId: 'op_access_1', requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3, deviceId: DEVICE,
        proofKeyThumbprint: h.keys.proofKey.thumbprint, ownerId: OWNER, channelRef: CHANNEL,
      },
      expiresAt: new Date(T0 + CHANNEL_ACCESS_GRANT_LIFETIME_MS).toISOString(),
    });

    const opened = decodeSealedGrantPayload(openEnvelope(envelope.ciphertext, h.keys));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.grant).toBe(h.issuer.minted[0]);
    expect(validateSealedGrantPayload(opened.value, {
      operationId: 'op_access_1', requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3, deviceId: DEVICE,
      proofKeyThumbprint: h.keys.proofKey.thumbprint, recipientKeyThumbprint: h.keys.encryptionKey.thumbprint, nowMs: T0,
    })).toBe('valid');
    // Authority is rechecked immediately before admission and again immediately before minting.
    expect(h.authority.calls).toHaveLength(2);
    expect(new Set(h.authority.calls.map(call => call.claimOperationId)).size).toBe(1);
  });

  it('never persists or returns the plaintext grant outside the sealed box', async () => {
    const h = await harness();
    const envelope = envelopeOf(await h.exchange());
    const persisted = JSON.stringify([...h.backing.records.values()]);
    expect(persisted).not.toContain(h.issuer.minted[0]);
    expect(JSON.stringify(envelope)).not.toContain(h.issuer.minted[0]);
    expect(persisted).toContain(envelope.ciphertext);
  });

  // Wrong-implementation test (contract RD5A): retrying after a committed provider
  // result must return the stored envelope without a second provider call or fresh sealing.
  it('returns the byte-identical stored envelope on retry without a second provider call or fresh sealing', async () => {
    const h = await harness();
    const first = envelopeOf(await h.exchange());
    h.setNow(T0 + 60_000);
    const retry = envelopeOf(await h.exchange());

    expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
    expect(h.provider.admits).toHaveLength(1);
    expect(h.provider.reconciles).toHaveLength(0);
    expect(h.issuer.minted).toHaveLength(1);
    expect(h.authority.calls).toHaveLength(2);
  });

  it('reconciles a provider commit whose response was lost instead of admitting again', async () => {
    const h = await harness();
    h.provider.behavior.admit.push('commit_then_lose');
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.provider.applied.size).toBe(1);
    expect(h.issuer.minted).toHaveLength(0);

    const envelope = envelopeOf(await h.exchange());
    expect(h.provider.admits).toHaveLength(1);
    expect(h.provider.reconciles).toHaveLength(1);
    expect(h.issuer.minted).toHaveLength(1);
    expect(JSON.stringify(envelopeOf(await h.exchange()))).toBe(JSON.stringify(envelope));
    expect(h.provider.admits).toHaveLength(1);
  });

  it('invokes the recorded provider operation after a crash before the first invocation', async () => {
    const h = await harness();
    // The adapter throws before applying, as if the process died after `admitting` was persisted.
    h.provider.behavior.admit.push('crash_before');
    expect((await h.exchange()).kind).toBe('unavailable');
    expect(h.provider.applied.size).toBe(0);

    envelopeOf(await h.exchange());
    expect(h.provider.reconciles).toHaveLength(1);
    expect(h.provider.applied.size).toBe(1);
    const operations = new Set(h.provider.admits.map(admit => admit.providerOperationId));
    expect(operations.size).toBe(1);
  });

  it('keeps unresolved admission ambiguity unavailable and never mints', async () => {
    const h = await harness();
    h.provider.behavior.admit.push('unknown');
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    h.provider.behavior.reconcile.push('unknown', 'unavailable');
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.provider.admits).toHaveLength(1);
    expect(h.issuer.minted).toHaveLength(0);
  });

  it('closes without membership when approval is lost immediately before exchange', async () => {
    for (const reason of ['closed', 'expired'] as const) {
      const h = await harness();
      h.authority.state.next = () => ({ kind: 'closed', reason });
      expect(await h.exchange()).toEqual({ kind: 'rejected', code: reason });
      expect(h.provider.admits).toHaveLength(0);
      expect(h.issuer.minted).toHaveLength(0);
      // A closed exchange stays closed; it never re-asks for authority.
      h.authority.state.next = input => ({ kind: 'authorized', authorization: authorization({ operationId: input.operationId }) });
      expect(await h.exchange()).toEqual({ kind: 'rejected', code: reason });
      expect(h.provider.admits).toHaveLength(0);
    }
  });

  it('rechecks authority between admission and minting', async () => {
    const h = await harness();
    h.authority.state.next = (input, call) => call === 1
      ? { kind: 'authorized', authorization: authorization({ operationId: input.operationId }) }
      : { kind: 'closed', reason: 'closed' };
    expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'closed' });
    expect(h.provider.admits).toHaveLength(1);
    expect(h.issuer.minted).toHaveLength(0);
  });

  it('treats the persisted request deadline as exclusive at the exact boundary', async () => {
    const deadline = Date.parse(DEADLINE);
    const late = await harness();
    late.setNow(deadline);
    expect(await late.exchange()).toEqual({ kind: 'rejected', code: 'expired' });
    expect(late.provider.admits).toHaveLength(0);

    const early = await harness();
    early.setNow(deadline - 1);
    envelopeOf(await early.exchange());
  });

  it('refuses an authorization for another requester, session, or operation', async () => {
    for (const drift of [
      { requester: 'principal_2' as typeof REQUESTER },
      { sessionGeneration: 4 },
      { sessionFingerprint: 'e'.repeat(43) },
      { origin: 'https://other.example' },
    ]) {
      const h = await harness();
      h.authority.state.next = input => ({ kind: 'authorized', authorization: authorization({ operationId: input.operationId, ...drift }) });
      expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'closed' });
      expect(h.provider.admits).toHaveLength(0);
    }
  });

  it('closes the journal request when the provider refuses admission', async () => {
    const h = await harness();
    h.provider.behavior.admit.push('reject');
    expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'closed' });
    expect(h.authority.closes).toHaveLength(1);
    expect(h.issuer.minted).toHaveLength(0);
  });

  it('binds the first device, proof key, and session generation to the operation', async () => {
    const h = await harness();
    envelopeOf(await h.exchange());
    const other = await connectorKeys();
    expect(await h.port.exchange(await validatedRequest(h.keys, { deviceId: 'device_agent_2' as typeof DEVICE })))
      .toEqual({ kind: 'rejected', code: 'wrong_device' });
    expect(await h.port.exchange(await validatedRequest({ ...h.keys, proofKey: other.proofKey })))
      .toEqual({ kind: 'rejected', code: 'proof_mismatch' });
    expect(await h.port.exchange(await validatedRequest(h.keys, { sessionGeneration: 4 })))
      .toEqual({ kind: 'rejected', code: 'wrong_generation' });
    // Grant theft: another verified session presenting the same operation and keys.
    const thief = h.service.forConnector({ sessionFingerprint: 'e'.repeat(43) });
    expect(await thief.exchange(await h.request())).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(h.provider.admits).toHaveLength(1);
    expect(h.issuer.minted).toHaveLength(1);
  });

  it('lets a new recovery key supersede the old one only before sealing', async () => {
    const h = await harness();
    h.provider.behavior.admit.push('unavailable');
    expect((await h.exchange()).kind).toBe('unavailable');
    const rotated = await connectorKeys();
    const keys = { ...h.keys, encryptionKey: rotated.encryptionKey, box: rotated.box };
    const envelope = envelopeOf(await h.port.exchange(await validatedRequest(keys)));
    expect(envelope.recipientKeyThumbprint).toBe(rotated.encryptionKey.thumbprint);
    expect(() => openEnvelope(envelope.ciphertext, h.keys)).toThrow();
    expect(decodeSealedGrantPayload(openEnvelope(envelope.ciphertext, keys)).ok).toBe(true);

    // After sealing, neither the superseded key nor a fresh one causes resealing.
    expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'encryption_key_mismatch' });
    const fresh = await connectorKeys();
    expect(await h.port.exchange(await validatedRequest({ ...h.keys, encryptionKey: fresh.encryptionKey })))
      .toEqual({ kind: 'rejected', code: 'encryption_key_mismatch' });
    expect(h.issuer.minted).toHaveLength(1);
  });

  it('refuses to reuse one encryption key for a second operation', async () => {
    const h = await harness();
    envelopeOf(await h.exchange());
    expect(await h.port.exchange(await validatedRequest(h.keys, { operationId: 'op_access_2' })))
      .toEqual({ kind: 'rejected', code: 'key_reuse' });
    expect(h.provider.admits).toHaveLength(1);
  });

  it('seals each operation only for its own context', async () => {
    const h = await harness();
    const first = envelopeOf(await h.exchange());
    const second = await connectorKeys();
    const envelope = envelopeOf(await h.port.exchange(await validatedRequest(
      { ...h.keys, encryptionKey: second.encryptionKey, box: second.box }, { operationId: 'op_access_2' },
    )));
    // Substituting op 1's envelope where op 2 is expected fails to open, and its context names op 1.
    expect(() => openEnvelope(first.ciphertext, { ...h.keys, box: second.box })).toThrow();
    const opened = decodeSealedGrantPayload(openEnvelope(first.ciphertext, h.keys));
    expect(opened.ok && validateSealedGrantPayload(opened.value, {
      operationId: 'op_access_2', requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3, deviceId: DEVICE,
      proofKeyThumbprint: h.keys.proofKey.thumbprint, recipientKeyThumbprint: h.keys.encryptionKey.thumbprint, nowMs: T0,
    })).toBe('operation_mismatch');
    expect(envelope.ciphertext).not.toBe(first.ciphertext);
    expect(new Set(h.provider.admits.map(admit => admit.providerOperationId)).size).toBe(2);
  });

  it('serves recovery until the hard envelope expiry, then expires without resealing', async () => {
    const h = await harness();
    const envelope = envelopeOf(await h.exchange());
    h.setNow(T0 + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS - 1);
    expect(JSON.stringify(envelopeOf(await h.exchange()))).toBe(JSON.stringify(envelope));
    h.setNow(T0 + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS);
    h.authority.state.next = () => ({ kind: 'closed', reason: 'expired' });
    expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'expired' });
    expect(h.issuer.minted).toHaveLength(1);
    expect(h.provider.admits).toHaveLength(1);
  });

  it('returns the first stored envelope when a racing exchange loses the sealing write', async () => {
    const h = await harness();
    h.provider.behavior.admit.push('unavailable');
    await h.exchange();
    const [a, b] = await Promise.all([h.exchange(), h.exchange()]);
    expect(JSON.stringify(envelopeOf(a))).toBe(JSON.stringify(envelopeOf(b)));
    expect(h.provider.applied.size).toBe(1);
  });

  it('collapses store and port failures to retryable unavailability', async () => {
    const h = await harness();
    h.backing.inject('read', 'throw');
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    h.authority.state.next = () => { throw new Error('secret'); };
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    h.authority.state.next = input => ({ kind: 'authorized', authorization: authorization({ operationId: input.operationId }) });
    h.issuer.state.unavailable = true;
    expect(await h.exchange()).toEqual({ kind: 'unavailable', retryable: true });
    h.issuer.state.unavailable = false;
    h.backing.inject('compareAndSet', 'lose_response');
    const settled = await h.exchange();
    expect(settled.kind === 'ok' || settled.kind === 'unavailable').toBe(true);
    envelopeOf(await h.exchange());
    expect(h.provider.applied.size).toBe(1);
  });
});
