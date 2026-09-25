import { createHash } from 'node:crypto';

export type DiscoverySecretPurpose = 'code' | 'credential' | 'limiter-source' | 'limiter-subject';

/** One-way, purpose-separated derivation for every bootstrap secret or bucket. */
export function digestDiscoverySecret(purpose: DiscoverySecretPurpose, value: string): string {
  return createHash('sha256').update(`khala.channel-discovery-bootstrap.${purpose}.v1\u0000${value}`).digest('base64url');
}

const PART = /^[A-Za-z0-9_-]{43}$/;
const REFERENCE = /^dcr_([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

export function credentialRef(slot: string, secret: string): string {
  if (!PART.test(slot) || !PART.test(secret)) throw new TypeError('invalid discovery credential material');
  return `dcr_${slot}.${secret}`;
}

export function parseCredentialRef(value: string): Readonly<{ slot: string; secret: string }> | null {
  const match = REFERENCE.exec(value);
  return match ? { slot: match[1]!, secret: match[2]! } : null;
}

export const discoveryStoreKeys = {
  code: (code: string) => `channel-discovery-bootstrap:code:${digestDiscoverySecret('code', code)}`,
  slot: (slot: string) => `channel-discovery-bootstrap:credential:${digestDiscoverySecret('credential', slot)}`,
  credential: (value: string) => `channel-discovery-bootstrap:credential-digest:${digestDiscoverySecret('credential', value)}`,
  proof: (jkt: string, jti: string) => `channel-discovery-bootstrap:proof:${digestDiscoverySecret('credential', `${jkt}\u0000${jti}`)}`,
} as const;
