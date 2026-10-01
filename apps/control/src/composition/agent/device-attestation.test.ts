import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { ControlStore, SessionBinding } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { checkProof, thumbprint } from '../../agent-bootstrap/proof';
import { fakeStore, T0 } from '../../invitations/support.test';
import { attestationBodyHash, createDeviceAttestationRoutes, DEVICE_CHALLENGE_PATH, DEVICE_REGISTER_PATH } from './device-attestation';

const origin = 'https://khala.aiur.team';
const token = 't'.repeat(43);
const fingerprint = 'A'.repeat(43);
const binding = {
  v: 1, bindingId: 'binding-device-1', ownerId: 'owner_1', agentParticipantId: 'agent_1',
  deviceId: 'device_1', harness: 'codex', sessionId: 'existing_1', generation: 2,
} as SessionBinding;

function signer() {
  const key = generateKeyPairSync('ed25519').privateKey;
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x } })).toString('base64url');
  return {
    jkt: thumbprint(jwk.x!),
    proof(method: string, url: string, accessToken: string, extra?: { nonce: string; bodyHash: string }) {
      const payload = Buffer.from(JSON.stringify({
        htm: method, htu: url, iat: Math.floor(T0 / 1000), jti: randomBytes(16).toString('base64url'),
        ath: createHash('sha256').update(accessToken).digest('base64url'),
        ...(extra ? { nonce: extra.nonce, body_hash: extra.bodyHash } : {}),
      })).toString('base64url');
      const data = `${header}.${payload}`;
      return `${data}.${sign(null, Buffer.from(data), key).toString('base64url')}`;
    },
  };
}

describe('proof-bound Matrix device attestation', () => {
  it('requires one-use body-signed consent, exact binding and published key; refuses replacement and revoked trust', async () => {
    const proofSigner = signer();
    const backing = fakeStore(() => T0);
    let storeUnavailable = false;
    const store: ControlStore = { ...backing.store,
      read: (key, options) => storeUnavailable && key.startsWith('agent-device.attestation.')
        ? Promise.resolve({ kind: 'unavailable' }) : backing.store.read(key, options),
    };
    let current = binding;
    let active = true;
    let bindingUnavailable = false;
    let published = fingerprint;
    const seen = new Set<string>();
    const capabilities = {
      async authorize(request: Request, action: string) {
        if (action !== 'publish_own' || request.headers.get('authorization') !== `DPoP ${token}`) {
          return { kind: 'refused' as const, status: 401 as const, code: 'invalid_capability' as const };
        }
        const proof = checkProof(request.headers.get('dpop'), {
          method: request.method, url: request.url, jkt: proofSigner.jkt, accessToken: token, nowMs: T0,
        });
        if (proof.kind !== 'valid' || seen.has(proof.jti)) {
          return { kind: 'refused' as const, status: 401 as const, code: 'invalid_proof' as const };
        }
        seen.add(proof.jti);
        return { kind: 'authorized' as const, action: 'publish_own' as const,
          ownerId: current.ownerId, roomId: 'room_1' as never, binding: current };
      },
      async lookupBinding() {
        if (bindingUnavailable) return { kind: 'unavailable' as const };
        return { kind: 'found' as const, ownerId: current.ownerId, generation: current.generation,
          deviceId: current.deviceId, status: active ? 'active' as const : 'revoked' as const };
      },
    };
    const routes = createDeviceAttestationRoutes({
      origin, store, capabilities, publishedFingerprint: async () => published,
      clock: () => T0,
    });
    const request = (path: string, method: 'GET' | 'POST', body?: object, extra?: { nonce: string; bodyHash: string }) => new Request(`${origin}${path}`, {
      method, headers: { authorization: `DPoP ${token}`, dpop: proofSigner.proof(method, `${origin}${path}`, token, extra),
        ...(body ? { 'content-type': 'application/json', origin } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const challenge = async () => {
      const response = await routes.agent[0]!.handle(request(DEVICE_CHALLENGE_PATH, 'GET'));
      expect(response.status).toBe(200);
      return (await response.json() as { nonce: string }).nonce;
    };
    const register = async (nonce: string, key: string, overrides: Partial<typeof binding> = {}) => {
      const body = { v: 1 as const, bindingId: overrides.bindingId ?? current.bindingId,
        deviceId: overrides.deviceId ?? current.deviceId, generation: overrides.generation ?? current.generation,
        nonce, fingerprint: key };
      return routes.agent[1]!.handle(request(DEVICE_REGISTER_PATH, 'POST', body, {
        nonce, bodyHash: attestationBodyHash(body),
      }));
    };

    expect(await routes.lookup(binding)).toBeNull(); // Matrix's arbitrary device list is not trust.
    expect(await routes.lookupState(binding)).toEqual({ kind: 'absent' });
    const wrong = await register(await challenge(), 'B'.repeat(43));
    expect(wrong.status).toBe(403);
    expect(await routes.lookup(binding)).toBeNull();

    const crossBinding = await register(await challenge(), fingerprint, { bindingId: 'binding-stolen' } as never);
    expect(crossBinding.status).toBe(403);
    expect(await routes.lookup(binding)).toBeNull();

    const nonce = await challenge();
    expect((await register(nonce, fingerprint)).status).toBe(200);
    expect(await routes.lookup(binding)).toMatchObject({ bindingId: binding.bindingId, fingerprint });
    expect(await routes.lookupState(binding)).toMatchObject({ kind: 'found', attestation: { fingerprint } });
    storeUnavailable = true;
    expect(await routes.lookupState(binding)).toEqual({ kind: 'unavailable' });
    storeUnavailable = false;
    bindingUnavailable = true;
    expect(await routes.lookupState(binding)).toEqual({ kind: 'unavailable' });
    bindingUnavailable = false;
    expect((await register(nonce, fingerprint)).status).toBe(403); // consumed challenge, even with a fresh proof

    published = 'B'.repeat(43);
    expect((await register(await challenge(), published)).status).toBe(409);
    expect((await routes.lookup(binding))?.fingerprint).toBe(fingerprint);

    current = { ...binding, generation: 3 };
    expect(await routes.lookup(binding)).toBeNull();
    current = binding;
    active = false;
    expect(await routes.lookup(binding)).toBeNull();
    expect((await routes.agent[0]!.handle(request(DEVICE_CHALLENGE_PATH, 'GET'))).status).toBe(403);
  });
});
