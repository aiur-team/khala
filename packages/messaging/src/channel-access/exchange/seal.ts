// Seals a grant payload to the connector's X25519 recovery key with libsodium's
// audited `crypto_box_seal` (decision 41). Nothing here implements a primitive:
// the pinned `libsodium-wrappers` binding does the key agreement and AEAD.
// `crypto_box_seal` has no associated-data input, so the authenticated context
// travels inside the sealed plaintext.

import {
  CHANNEL_SEALED_BOX_ALGORITHM,
  type SealedGrantEnvelope,
  type SealedGrantPayload,
  decodeSealedGrantEnvelope,
  decodeSealedGrantPayload,
} from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';

/**
 * Canonical plaintext: the strict v1 payload, re-decoded, with a fixed field
 * order. Returns `null` when the payload is invalid, the key is not a 32-byte
 * X25519 public key, or the resulting envelope would not decode.
 */
export async function sealGrantPayload(
  payload: SealedGrantPayload,
  recipientPublicKey: string,
): Promise<SealedGrantEnvelope | null> {
  const decoded = decodeSealedGrantPayload(payload);
  if (!decoded.ok) return null;
  const value = decoded.value;
  const canonical = JSON.stringify({
    v: value.v,
    operationId: value.operationId,
    requester: value.requester,
    origin: value.origin,
    sessionGeneration: value.sessionGeneration,
    deviceId: value.deviceId,
    proofKeyThumbprint: value.proofKeyThumbprint,
    recipientKeyThumbprint: value.recipientKeyThumbprint,
    expiresAt: value.expiresAt,
    grant: value.grant,
  });
  try {
    await sodium.ready;
    const publicKey = sodium.from_base64(recipientPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) return null;
    const ciphertext = sodium.crypto_box_seal(sodium.from_string(canonical), publicKey);
    const envelope = decodeSealedGrantEnvelope({
      v: 1,
      algorithm: CHANNEL_SEALED_BOX_ALGORITHM,
      recipientKeyThumbprint: value.recipientKeyThumbprint,
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
    });
    return envelope.ok ? envelope.value : null;
  } catch {
    return null;
  }
}
