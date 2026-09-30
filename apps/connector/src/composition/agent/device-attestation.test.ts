import { createHash, generateKeyPairSync } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { createProofSigner } from '@khala/connector/bootstrap/proof';
import { describe, expect, it, vi } from 'vitest';
import { createAgentDeviceAttestation } from './device-attestation';

const origin = 'https://khala.example';
const now = Date.parse('2026-09-30T12:00:00Z');
const binding = { v: 1, bindingId: 'binding_device_1', ownerId: 'owner_1', agentParticipantId: 'agent_1',
  deviceId: 'DEVICE_1', harness: 'proof-key', sessionId: 'agent_1', generation: 2 } as SessionBinding;
const token = 'A'.repeat(43);
const fingerprint = 'B'.repeat(43);
const nonce = 'C'.repeat(43);
const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => now);
const capability = { token, bindingId: binding.bindingId, generation: binding.generation,
  scope: ['publish_own', 'receive_released', 'ack_delivery'] as const, expiresAt: now + 3_600_000 };

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('agent Matrix device attestation', () => {
  it('signs a one-use challenge and exact current Matrix fingerprint before caching success', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? reply({ v: 1, nonce, expiresAt: now + 60_000 }) : reply({ v: 1, kind: 'attested' });
    }) as typeof fetch;
    const attestation = createAgentDeviceAttestation({ appOrigin: origin, binding, signer,
      capability: async () => capability, fingerprint: () => fingerprint, fetch: fetcher, clock: () => now });
    expect(await attestation.ensure()).toEqual({ kind: 'attested' });
    expect(await attestation.ensure()).toEqual({ kind: 'attested' });
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.url)).toEqual([
      `${origin}/api/agent/device-attestation/challenge`, `${origin}/api/agent/device-attestation/register`,
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect((init.headers as Record<string, string>).authorization).toBe(`DPoP ${token}`);
    }
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ v: 1, bindingId: binding.bindingId, deviceId: binding.deviceId,
      generation: binding.generation, nonce, fingerprint });
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.origin).toBe(origin);
    const claims = JSON.parse(Buffer.from(headers.dpop!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ htm: 'POST', htu: calls[1]!.url, nonce,
      ath: createHash('sha256').update(token).digest('base64url'),
      body_hash: createHash('sha256').update(JSON.stringify(body)).digest('base64url') });
  });

  it('fails closed on a mismatched capability or invalid fingerprint before making requests', async () => {
    const fetcher = vi.fn(async () => reply({ v: 1, nonce, expiresAt: now + 60_000 }));
    const wrongCapability = createAgentDeviceAttestation({ appOrigin: origin, binding, signer,
      capability: async () => ({ ...capability, bindingId: 'other' as never }), fingerprint: () => fingerprint,
      fetch: fetcher as typeof fetch, clock: () => now });
    expect(await wrongCapability.ensure()).toEqual({ kind: 'unavailable', stage: 'capability' });
    const wrongFingerprint = createAgentDeviceAttestation({ appOrigin: origin, binding, signer,
      capability: async () => capability, fingerprint: () => 'unpublished key',
      fetch: fetcher as typeof fetch, clock: () => now });
    expect(await wrongFingerprint.ensure()).toEqual({ kind: 'unavailable', stage: 'fingerprint' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a fresh valid challenge and retries after a transient registration failure', async () => {
    let attempts = 0;
    const fetcher = (async (url: string) => {
      if (url.endsWith('/challenge')) return reply({ v: 1, nonce, expiresAt: now + 60_000 });
      attempts++;
      return attempts === 1 ? new Response('unavailable', { status: 503 }) : reply({ v: 1, kind: 'attested' });
    }) as typeof fetch;
    const attestation = createAgentDeviceAttestation({ appOrigin: origin, binding, signer,
      capability: async () => capability, fingerprint: () => fingerprint, fetch: fetcher, clock: () => now });
    expect(await attestation.ensure()).toEqual({ kind: 'unavailable', stage: 'register_response' });
    expect(await attestation.ensure()).toEqual({ kind: 'attested' });
    expect(attempts).toBe(2);
  });

  it('does not register with a malformed or expired challenge', async () => {
    const fetcher = vi.fn(async () => reply({ v: 1, nonce, expiresAt: now }));
    const attestation = createAgentDeviceAttestation({ appOrigin: origin, binding, signer,
      capability: async () => capability, fingerprint: () => fingerprint, fetch: fetcher as typeof fetch,
      clock: () => now });
    expect(await attestation.ensure()).toEqual({ kind: 'unavailable', stage: 'challenge_response' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
