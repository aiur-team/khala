import { describe, expect, it, vi } from 'vitest';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { MatrixConnectorSubstrate } from '../../substrate/matrix';
import { createOwnerDeviceTrust } from './owner-device-trust';

const binding = { v: 1, bindingId: 'binding-owner-trust', ownerId: 'owner-one',
  agentParticipantId: 'agent-one', deviceId: 'AGENT_ONE', harness: 'codex',
  sessionId: 'session-one', generation: 2 } as SessionBinding;
const origin = 'https://khala.aiur.team';
const fingerprint = 'A'.repeat(43);
const list = (devices: unknown, roomId = '!room:example') => Response.json({ v: 1, roomId, devices });

function fixture(fetch: typeof globalThis.fetch) {
  const trustPeer = vi.fn(async () => undefined);
  const signer = { proof: vi.fn(() => 'signed') } as unknown as ProofSigner;
  const trust = createOwnerDeviceTrust({ appOrigin: origin, binding, roomId: '!room:example',
    ownerUserId: '@owner:example', signer,
    capability: async () => ({ token: 'B'.repeat(43), bindingId: binding.bindingId,
      generation: binding.generation, scope: ['receive_released'], expiresAt: Date.now() + 60_000 }),
    matrix: { trustPeer } as unknown as MatrixConnectorSubstrate, fetch,
  });
  return { trust, trustPeer, signer };
}

describe('owner-approved Matrix device trust', () => {
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
