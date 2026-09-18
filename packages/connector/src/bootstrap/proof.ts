// Sender-constrained request proofs (RFC 9449 DPoP semantics, as proved by
// KHA-144). The connector's Ed25519 key signs each bootstrap request, so a grant
// copied out of a log or browser history is useless without that key. Key
// persistence belongs to connector storage (KHA-115); this module only signs.

import { type KeyObject, createHash, createPublicKey, randomBytes, sign } from 'node:crypto';

export type ProofSigner = Readonly<{
  /** RFC 7638 thumbprint of the public key, base64url. */
  jkt: string;
  /** A fresh single-use proof for exactly this method and URL. */
  proof(method: string, url: string, accessToken?: string): string;
}>;

type PublicJwk = Readonly<{ kty: 'OKP'; crv: 'Ed25519'; x: string }>;

export function createProofSigner(privateKey: KeyObject, clock: () => number = Date.now): ProofSigner {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('proof key must be an Ed25519 private key');
  }
  const exported = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof exported.x !== 'string') throw new Error('proof key has no public component');
  const jwk: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x };
  const header = encode({ alg: 'EdDSA', typ: 'dpop+jwt', jwk });
  return {
    jkt: thumbprint(jwk),
    proof(method, url, accessToken) {
      const claims: Record<string, string | number> = {
        htm: method,
        htu: url,
        iat: Math.floor(clock() / 1000),
        jti: randomBytes(16).toString('base64url'),
      };
      if (accessToken !== undefined) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
      const input = `${header}.${encode(claims)}`;
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    },
  };
}

/** RFC 7638: required members only, lexicographic order, no whitespace. */
export function thumbprint(jwk: PublicJwk): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
