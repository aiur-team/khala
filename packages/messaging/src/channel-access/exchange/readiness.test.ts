import type { ChannelAccessReadiness } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS, createGrantExchangeService } from './service';
import {
  DEVICE,
  FINGERPRINT,
  ORIGIN,
  REQUESTER,
  T0,
  connectorKeys,
  fakeAuthority,
  fakeControlStore,
  fakeIssuer,
  fakeProvider,
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
    store: backing.store, authority: authority.port, provider: provider.port, issuer: issuer.port, clock: () => now,
  });
  const keys = await connectorKeys();
  const port = service.forConnector({ sessionFingerprint: FINGERPRINT });
  const readiness = (overrides: Partial<ChannelAccessReadiness> = {}): ChannelAccessReadiness => ({
    v: 1,
    operationId: 'op_access_1',
    requester: REQUESTER,
    origin: ORIGIN,
    sessionGeneration: 3,
    deviceId: DEVICE,
    proofKeyThumbprint: keys.proofKey.thumbprint,
    recipientKeyThumbprint: keys.encryptionKey.thumbprint,
    ...overrides,
  });
  return {
    backing, authority, provider, issuer, service, keys, port, readiness,
    exchange: async () => port.exchange(await validatedRequest(keys, {}, now)),
    setNow(value: number) { now = value; },
  };
}

describe('channel-access readiness acknowledgement', () => {
  it('marks the journal connected, then deletes the stored envelope', async () => {
    const h = await harness();
    const sealed = await h.exchange();
    if (sealed.kind !== 'ok') throw new Error('not sealed');
    expect(JSON.stringify([...h.backing.records.values()])).toContain(sealed.value.ciphertext);

    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'ok', value: null });
    expect(h.authority.marks).toHaveLength(1);
    expect(h.authority.marks[0]).toMatchObject({ operationId: 'op_access_1', requester: REQUESTER, sessionGeneration: 3 });
    expect(JSON.stringify([...h.backing.records.values()])).not.toContain(sealed.value.ciphertext);
    // Recovery is over: a later exchange cannot fetch the envelope again, mint or admit.
    expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'closed' });
    expect(h.issuer.minted).toHaveLength(1);
    expect(h.provider.admits).toHaveLength(1);
  });

  it('treats a duplicate acknowledgement as the same success without a second journal write', async () => {
    const h = await harness();
    await h.exchange();
    await h.port.acknowledge(h.readiness());
    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'ok', value: null });
    expect(h.authority.marks).toHaveLength(1);
  });

  it('keeps the envelope when the journal cannot be marked connected', async () => {
    const h = await harness();
    const sealed = await h.exchange();
    if (sealed.kind !== 'ok') throw new Error('not sealed');
    h.authority.markResults.push('unavailable');
    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'unavailable', retryable: true });
    // The connector can still recover the same bytes and acknowledge again.
    const again = await h.exchange();
    expect(again.kind === 'ok' && again.value.ciphertext).toBe(sealed.value.ciphertext);
    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'ok', value: null });
  });

  it('closes and deletes the envelope when the request closed before readiness', async () => {
    const h = await harness();
    const sealed = await h.exchange();
    if (sealed.kind !== 'ok') throw new Error('not sealed');
    h.authority.markResults.push('closed');
    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'rejected', code: 'closed' });
    expect(JSON.stringify([...h.backing.records.values()])).not.toContain(sealed.value.ciphertext);
    expect(await h.exchange()).toEqual({ kind: 'rejected', code: 'closed' });
  });

  it('never acknowledges an exchange that was not sealed', async () => {
    const h = await harness();
    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    h.provider.behavior.admit.push('unavailable');
    await h.exchange();
    expect(await h.port.acknowledge(h.readiness())).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(h.authority.marks).toHaveLength(0);
  });

  it('refuses an acknowledgement for another device, proof key, recovery key, generation or session', async () => {
    const h = await harness();
    await h.exchange();
    const other = await connectorKeys();
    expect(await h.port.acknowledge(h.readiness({ deviceId: 'device_agent_2' as typeof DEVICE })))
      .toEqual({ kind: 'rejected', code: 'wrong_device' });
    expect(await h.port.acknowledge(h.readiness({ proofKeyThumbprint: other.proofKey.thumbprint })))
      .toEqual({ kind: 'rejected', code: 'proof_mismatch' });
    expect(await h.port.acknowledge(h.readiness({ recipientKeyThumbprint: other.encryptionKey.thumbprint })))
      .toEqual({ kind: 'rejected', code: 'encryption_key_mismatch' });
    expect(await h.port.acknowledge(h.readiness({ sessionGeneration: 4 })))
      .toEqual({ kind: 'rejected', code: 'wrong_generation' });
    expect(await h.service.forConnector({ sessionFingerprint: 'g'.repeat(43) }).acknowledge(h.readiness()))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(h.authority.marks).toHaveLength(0);
  });

  it('refuses readiness at the envelope hard expiry', async () => {
    const h = await harness();
    await h.exchange();
    h.setNow(T0 + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS);
    expect(await h.port.acknowledge(h.readiness())).toMatchObject({ kind: 'rejected' });
    expect(h.authority.marks).toHaveLength(0);
  });
});
