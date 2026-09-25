// Verifies the connector's sender-constrained request proof (RFC 9449 DPoP
// semantics, as proved by KHA-144): a compact EdDSA JWS whose embedded public key
// must match the thumbprint the grant is bound to. It is used only for bootstrap
// requests, and only Ed25519 is accepted. Signature checks use node:crypto.

import { type KeyObject, createHash, createPublicKey, verify } from 'node:crypto';
import { safeEqual } from '../auth/csrf';

/** Accepted proof age and future skew, in seconds. */
export const PROOF_MAX_AGE_S = 60;
export const PROOF_MAX_SKEW_S = 5;
const MAX_PROOF_BYTES = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEY_X = /^[A-Za-z0-9_-]{43}$/;
const JTI = /^[A-Za-z0-9_-]{16,64}$/;

export type ProofCheck =
  | Readonly<{ kind: 'valid'; jti: string; publicKey: string }>
  | Readonly<{ kind: 'invalid'; code: 'proof_required' | 'invalid_proof' | 'proof_key_mismatch' | 'proof_target_mismatch' | 'proof_token_mismatch' }>;

export type ProofExpectation = Readonly<{
  method: string;
  /** Exact request URL the proof must name. */
  url: string;
  /** Thumbprint the code or grant is bound to. */
  jkt: string;
  /** The grant presented with the request, when there is one. */
  accessToken?: string;
  nowMs: number;
}>;

/** Checks form, key binding, signature, target and freshness. Replay is the caller's check on `jti`. */
export function checkProof(proof: string | null, expected: ProofExpectation): ProofCheck {
  if (proof === null || proof.length === 0) return invalid('proof_required');
  if (proof.length > MAX_PROOF_BYTES) return invalid('invalid_proof');
  const parts = proof.split('.');
  if (parts.length !== 3 || !parts.every(part => B64URL.test(part))) return invalid('invalid_proof');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = parseJson(encodedHeader);
  const payload = parseJson(encodedPayload);
  if (!header || !payload) return invalid('invalid_proof');
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || typeof jwk !== 'object' || jwk === null
    || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !KEY_X.test(jwk.x) || 'd' in jwk) {
    return invalid('invalid_proof');
  }
  if (!safeEqual(thumbprint(jwk.x), expected.jkt)) return invalid('proof_key_mismatch');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  } catch {
    return invalid('invalid_proof');
  }
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64 || !verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, signature)) {
    return invalid('invalid_proof');
  }
  const now = Math.floor(expected.nowMs / 1000);
  const { iat, jti } = payload;
  if (!Number.isSafeInteger(iat) || (iat as number) < now - PROOF_MAX_AGE_S || (iat as number) > now + PROOF_MAX_SKEW_S
    || typeof jti !== 'string' || !JTI.test(jti)) {
    return invalid('invalid_proof');
  }
  if (payload.htm !== expected.method || payload.htu !== expected.url) return invalid('proof_target_mismatch');
  if (expected.accessToken === undefined) {
    if ('ath' in payload) return invalid('proof_token_mismatch');
  } else if (typeof payload.ath !== 'string' || !safeEqual(payload.ath, createHash('sha256').update(expected.accessToken).digest('base64url'))) {
    return invalid('proof_token_mismatch');
  }
  return { kind: 'valid', jti, publicKey: jwk.x };
}

/** RFC 7638 thumbprint of an Ed25519 public key. */
export function thumbprint(x: string): string {
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
}

function parseJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function invalid(code: Extract<ProofCheck, { kind: 'invalid' }>['code']): ProofCheck {
  return { kind: 'invalid', code };
}
