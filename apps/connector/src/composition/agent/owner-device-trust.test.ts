import { describe, expect, it, vi } from 'vitest';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { MatrixConnectorSubstrate } from '../../substrate/matrix';
import { createOwnerDeviceTrust } from './owner-device-trust';
import type { DeviceAttestationResult } from './device-attestation';

const binding = { v: 1, bindingId: 'binding-owner-trust', ownerId: 'owner-one',
  agentParticipantId: 'agent-one', deviceId: 'AGENT_ONE', harness: 'codex',
  sessionId: 'session-one', generation: 2 } as SessionBinding;
const origin = 'https://khala.aiur.team';
const fingerprint = 'A'.repeat(43);
const list = (devices: unknown, roomId = '!room:example') => Response.json({ v: 1, roomId, devices });

function fixture(fetch: typeof globalThis.fetch,
  registerOwnDevice: () => Promise<DeviceAttestationResult> = async () => ({ kind: 'attested' }),
  capability: Parameters<typeof createOwnerDeviceTrust>[0]['capability'] = async () => ({ token: 'B'.repeat(43), bindingId: binding.bindingId,
    generation: binding.generation, scope: ['receive_released'], expiresAt: Date.now() + 60_000 }),
  trustPeer = vi.fn(async () => undefined)) {
  const diagnostic = vi.fn();
  const signer = { proof: vi.fn(() => 'signed') } as unknown as ProofSigner;
  const trust = createOwnerDeviceTrust({ appOrigin: origin, binding, roomId: '!room:example',
    ownerUserId: '@owner:example', signer,
    capability,
    registerOwnDevice,
    matrix: { trustPeer } as unknown as MatrixConnectorSubstrate, fetch, diagnostic,
  });
  return { trust, trustPeer, signer, diagnostic };
}

describe('owner-approved Matrix device trust', () => {
  it('does not look up owner pins until the current agent device is attested', async () => {
    const fetch = vi.fn(async () => list([{ deviceId: 'BROWSER_ONE', fingerprint }]));
    let attested = false;
    const { trust, trustPeer, diagnostic } = fixture(fetch, async () => attested
      ? { kind: 'attested' } : { kind: 'unavailable', stage: 'register_response' });
    expect(await trust.ensure()).toBe('unavailable');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ stage: 'owner_device_attestation_register_response', result: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(trustPeer).not.toHaveBeenCalled();
    attested = true;
    expect(await trust.ensure()).toBe('active');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('distinguishes capability preflight from a successful empty owner pin lookup', async () => {
    const fetch = vi.fn(async () => list([]));
    const noCapability = fixture(fetch, undefined, async () => null);
    expect(await noCapability.trust.ensure()).toBe('unavailable');
    expect(noCapability.diagnostic).toHaveBeenCalledExactlyOnceWith({ stage: 'owner_device_capability', result: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();

    const empty = fixture(fetch);
    expect(await empty.trust.ensure()).toBe('unavailable');
    expect(empty.diagnostic).toHaveBeenCalledExactlyOnceWith({ stage: 'owner_device_empty', result: 'unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reports Matrix key trust failure without changing the unavailable outcome', async () => {
    const trustPeer = vi.fn(async () => { throw new Error('private Matrix error'); });
    const { trust, diagnostic } = fixture(async () => list([{ deviceId: 'BROWSER_ONE', fingerprint }]),
      undefined, undefined, trustPeer);
    expect(await trust.ensure()).toBe('unavailable');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ stage: 'owner_device_trust_peer', result: 'unavailable' });
  });
  it('trusts only the protected server pin, never keys advertised by an arbitrary Matrix device list', async () => {
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      void args;
      return list([{ deviceId: 'BROWSER_ONE', fingerprint }]);
    });
    const { trust, trustPeer, signer } = fixture(fetch);
    expect(await trust.ensure()).toBe('active');
    expect(trustPeer).toHaveBeenCalledExactlyOnceWith('@owner:example', 'BROWSER_ONE', fingerprint);
    expect(await trust.ensure()).toBe('active');
    expect(trustPeer).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `DPoP ${'B'.repeat(43)}`, dpop: 'signed' });
    expect(signer.proof).toHaveBeenCalledWith('GET', `${origin}/api/agent/owner-device-proof/lookup`, 'B'.repeat(43));
  });

  it('fails closed for no pin, wrong room, key substitution and denied current binding', async () => {
    let reply = list([]);
    const { trust, trustPeer } = fixture(async () => reply);
    expect(await trust.ensure()).toBe('unavailable');
    reply = list([{ deviceId: 'BROWSER_ONE', fingerprint }], '!other:example');
    expect(await trust.ensure()).toBe('unavailable');
    reply = list([{ deviceId: 'BROWSER_ONE', fingerprint }]);
    expect(await trust.ensure()).toBe('active');
    reply = list([{ deviceId: 'BROWSER_ONE', fingerprint: 'C'.repeat(43) }]);
    expect(await trust.ensure()).toBe('revoked');
    expect(trustPeer).toHaveBeenCalledTimes(1);
    reply = list([]);
    expect(await trust.ensure()).toBe('revoked');
    reply = new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } });
    expect(await trust.ensure()).toBe('revoked');
  });
});
