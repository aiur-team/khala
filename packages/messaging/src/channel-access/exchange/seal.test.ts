import {
  CHANNEL_SEALED_BOX_ALGORITHM,
  type SealedGrantPayload,
  decodeSealedGrantEnvelope,
  decodeSealedGrantPayload,
  validateSealedGrantPayload,
} from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';
import { describe, expect, it } from 'vitest';
import { sealGrantPayload } from './seal';
import { DEVICE, ORIGIN, REQUESTER, T0, connectorKeys, openEnvelope } from './support.test';

async function payloadFor(keys: Awaited<ReturnType<typeof connectorKeys>>): Promise<SealedGrantPayload> {
  return {
    v: 1,
    operationId: 'op_access_1',
    requester: REQUESTER,
    origin: ORIGIN,
    sessionGeneration: 3,
    deviceId: DEVICE,
    proofKeyThumbprint: keys.proofKey.thumbprint,
    recipientKeyThumbprint: keys.encryptionKey.thumbprint,
    expiresAt: new Date(T0 + 15 * 60_000).toISOString(),
    grant: 'cagrant_secret_value',
  };
}

function expected(keys: Awaited<ReturnType<typeof connectorKeys>>, overrides: Partial<Parameters<typeof validateSealedGrantPayload>[1]> = {}) {
  return {
    operationId: 'op_access_1',
    requester: REQUESTER,
    origin: ORIGIN,
    sessionGeneration: 3,
    deviceId: DEVICE,
    proofKeyThumbprint: keys.proofKey.thumbprint,
    recipientKeyThumbprint: keys.encryptionKey.thumbprint,
    nowMs: T0,
    ...overrides,
  };
}

describe('grant sealing on the pinned libsodium binding', () => {
  it('matches the published Curve25519 known-answer key vector', async () => {
    await sodium.ready;
    // RFC 7748 §6.1 Alice key pair, also the libsodium test vector.
    const keys = sodium.crypto_box_seed_keypair(sodium.from_hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'));
    const alice = sodium.crypto_scalarmult_base(sodium.from_hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'));
    expect(sodium.to_hex(alice)).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(sodium.to_hex(keys.publicKey)).toBe('ed7749b4d989f6957f3bfde6c56767e988e21c9f8784d91d610011cd553f9b06');
    const shared = sodium.crypto_scalarmult(
      sodium.from_hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
      sodium.from_hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'),
    );
    expect(sodium.to_hex(shared)).toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  });

  it('seals the canonical v1 context so only the recipient key opens it', async () => {
    const keys = await connectorKeys();
    const payload = await payloadFor(keys);
    const envelope = await sealGrantPayload(payload, keys.encryptionKey.publicKey);
    expect(envelope).not.toBeNull();
    expect(decodeSealedGrantEnvelope(envelope)).toEqual({ ok: true, value: envelope });
    expect(envelope!.algorithm).toBe(CHANNEL_SEALED_BOX_ALGORITHM);
    expect(envelope!.recipientKeyThumbprint).toBe(keys.encryptionKey.thumbprint);
    expect(JSON.stringify(envelope)).not.toContain(payload.grant);

    const opened = openEnvelope(envelope!.ciphertext, keys);
    expect(Object.keys(opened as object)).toEqual([
      'v', 'operationId', 'requester', 'origin', 'sessionGeneration', 'deviceId', 'proofKeyThumbprint',
      'recipientKeyThumbprint', 'expiresAt', 'grant',
    ]);
    expect(decodeSealedGrantPayload(opened)).toEqual({ ok: true, value: payload });
    expect(validateSealedGrantPayload(payload, expected(keys))).toBe('valid');

    const other = await connectorKeys();
    expect(() => openEnvelope(envelope!.ciphertext, other)).toThrow();
  });

  it('rejects ciphertext tampering and truncation', async () => {
    const keys = await connectorKeys();
    const envelope = (await sealGrantPayload(await payloadFor(keys), keys.encryptionKey.publicKey))!;
    const bytes = sodium.from_base64(envelope.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
    const encode = (value: Uint8Array) => sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
    for (const index of [0, 31, 32, 47, bytes.length - 1]) {
      const flipped = Uint8Array.from(bytes);
      flipped[index] = flipped[index]! ^ 0x01;
      expect(() => openEnvelope(encode(flipped), keys)).toThrow();
    }
    expect(() => openEnvelope(encode(bytes.slice(0, bytes.length - 1)), keys)).toThrow();
    expect(() => openEnvelope(encode(bytes.slice(0, 47)), keys)).toThrow();
  });

  it('refuses envelope version, algorithm, and header drift', async () => {
    const keys = await connectorKeys();
    const envelope = (await sealGrantPayload(await payloadFor(keys), keys.encryptionKey.publicKey))!;
    expect(decodeSealedGrantEnvelope({ ...envelope, v: 2 }).ok).toBe(false);
    expect(decodeSealedGrantEnvelope({ ...envelope, algorithm: 'hpke_x25519_hkdf_sha256_chacha20poly1305' }).ok).toBe(false);
    expect(decodeSealedGrantEnvelope({ ...envelope, grant: 'leak' }).ok).toBe(false);
    // A relabelled recipient no longer matches the thumbprint sealed inside.
    const other = await connectorKeys();
    const opened = decodeSealedGrantPayload(openEnvelope(envelope.ciphertext, keys));
    expect(opened.ok && validateSealedGrantPayload(opened.value, expected(keys, {
      recipientKeyThumbprint: other.encryptionKey.thumbprint,
    }))).toBe('encryption_key_mismatch');
  });

  it('rejects a forged box whose sealed context names another operation, device, or session', async () => {
    // Sealed boxes are anonymous: anyone with the public key can seal. The sealed
    // context, not the box, is what binds the result to this exchange.
    const keys = await connectorKeys();
    const payload = await payloadFor(keys);
    const cases: [Partial<SealedGrantPayload>, string][] = [
      [{ operationId: 'op_access_2' }, 'operation_mismatch'],
      [{ requester: 'principal_2' as SealedGrantPayload['requester'] }, 'wrong_requester'],
      [{ origin: 'https://other.example' }, 'wrong_origin'],
      [{ sessionGeneration: 4 }, 'wrong_generation'],
      [{ deviceId: 'device_agent_2' as SealedGrantPayload['deviceId'] }, 'wrong_device'],
      [{ proofKeyThumbprint: keys.encryptionKey.thumbprint }, 'proof_mismatch'],
      [{ expiresAt: new Date(T0).toISOString() }, 'expired'],
    ];
    for (const [change, reason] of cases) {
      const forged = (await sealGrantPayload({ ...payload, ...change }, keys.encryptionKey.publicKey))!;
      const opened = decodeSealedGrantPayload(openEnvelope(forged.ciphertext, keys));
      expect(opened.ok && validateSealedGrantPayload(opened.value, expected(keys))).toBe(reason);
    }
  });

  it('refuses to seal an invalid payload or to a malformed key', async () => {
    const keys = await connectorKeys();
    const payload = await payloadFor(keys);
    expect(await sealGrantPayload({ ...payload, v: 2 } as unknown as SealedGrantPayload, keys.encryptionKey.publicKey)).toBeNull();
    expect(await sealGrantPayload({ ...payload, extra: 1 } as unknown as SealedGrantPayload, keys.encryptionKey.publicKey)).toBeNull();
    expect(await sealGrantPayload(payload, keys.encryptionKey.publicKey.slice(0, 40))).toBeNull();
    expect(await sealGrantPayload(payload, '!!!')).toBeNull();
  });
});
