// Discovery-only descriptor for an unjoined internal agent, plus its separate
// connector proof key. `khala internal discovery` writes both as owner-private
// 0600 files below `<internal root>/discovery/<principal>/`.
//
// The descriptor's capability authorizes exactly listing channels, requesting
// access and submitting a create intent. It never sends, receives, decides,
// creates a channel or exchanges a grant. The connector key is a different
// file: only a proof signed with it can call the connector-only grant
// exchange, so the descriptor alone can never reach that route.
//
// The loopback origin is not stored here; clients read it from the current
// `active.json` on every use.

import { isInternalCapability, isInternalIdentifier } from './descriptor';

export const INTERNAL_DISCOVERY_DIRECTORY = 'discovery';
export const INTERNAL_DISCOVERY_DESCRIPTOR_FILE = 'descriptor.json';
export const INTERNAL_CONNECTOR_KEY_FILE = 'connector-key.json';
export const MAX_INTERNAL_DISCOVERY_FILE_BYTES = 1_024;

export const INTERNAL_DISCOVERY_SCOPES = ['list_channels', 'request_channel_access', 'request_channel_create'] as const;

export type InternalDiscoveryDescriptor = Readonly<{
  v: 1;
  kind: 'discovery';
  /** Stable per harness session; reissuing rotates the capability, never the principal. */
  principal: string;
  generation: number;
  discoveryCapability: string;
  scopes: typeof INTERNAL_DISCOVERY_SCOPES;
}>;

/** Ed25519 JWK members, each unpadded base64url of exactly 32 bytes. */
export type InternalConnectorKey = Readonly<{
  v: 1;
  kind: 'connector_proof_key';
  principal: string;
  generation: number;
  publicKey: string;
  privateKey: string;
}>;

export type DecodedInternalFile<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; field: string }>;

const KEY_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const PRINCIPAL = /^agent_[A-Za-z0-9_-]{43}$/;

export function isDiscoveryPrincipal(value: unknown): value is string {
  return typeof value === 'string' && PRINCIPAL.test(value) && isInternalIdentifier(value);
}

function parse(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_INTERNAL_DISCOVERY_FILE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exact(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of Object.keys(record)) if (!keys.includes(key)) return key;
  for (const key of keys) if (!Object.hasOwn(record, key)) return key;
  return null;
}

function generation(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function parseInternalDiscoveryDescriptor(text: string): DecodedInternalFile<InternalDiscoveryDescriptor> {
  const record = parse(text);
  if (!record) return { ok: false, field: '' };
  const extra = exact(record, ['v', 'kind', 'principal', 'generation', 'discoveryCapability', 'scopes']);
  if (extra !== null) return { ok: false, field: extra };
  if (record.v !== 1) return { ok: false, field: 'v' };
  if (record.kind !== 'discovery') return { ok: false, field: 'kind' };
  if (!isDiscoveryPrincipal(record.principal)) return { ok: false, field: 'principal' };
  if (!generation(record.generation)) return { ok: false, field: 'generation' };
  if (!isInternalCapability(record.discoveryCapability)) return { ok: false, field: 'discoveryCapability' };
  const scopes = record.scopes;
  if (!Array.isArray(scopes) || scopes.length !== INTERNAL_DISCOVERY_SCOPES.length
    || scopes.some((scope, index) => scope !== INTERNAL_DISCOVERY_SCOPES[index])) return { ok: false, field: 'scopes' };
  return {
    ok: true,
    value: {
      v: 1, kind: 'discovery', principal: record.principal, generation: record.generation,
      discoveryCapability: record.discoveryCapability, scopes: INTERNAL_DISCOVERY_SCOPES,
    },
  };
}

export function encodeInternalDiscoveryDescriptor(value: InternalDiscoveryDescriptor): string {
  const text = `${JSON.stringify({
    v: 1, kind: 'discovery', principal: value.principal, generation: value.generation,
    discoveryCapability: value.discoveryCapability, scopes: INTERNAL_DISCOVERY_SCOPES,
  })}\n`;
  if (!parseInternalDiscoveryDescriptor(text).ok) throw new TypeError('internal discovery descriptor: invalid');
  return text;
}

export function parseInternalConnectorKey(text: string): DecodedInternalFile<InternalConnectorKey> {
  const record = parse(text);
  if (!record) return { ok: false, field: '' };
  const extra = exact(record, ['v', 'kind', 'principal', 'generation', 'publicKey', 'privateKey']);
  if (extra !== null) return { ok: false, field: extra };
  if (record.v !== 1) return { ok: false, field: 'v' };
  if (record.kind !== 'connector_proof_key') return { ok: false, field: 'kind' };
  if (!isDiscoveryPrincipal(record.principal)) return { ok: false, field: 'principal' };
  if (!generation(record.generation)) return { ok: false, field: 'generation' };
  if (typeof record.publicKey !== 'string' || !KEY_32.test(record.publicKey)) return { ok: false, field: 'publicKey' };
  if (typeof record.privateKey !== 'string' || !KEY_32.test(record.privateKey) || record.privateKey === record.publicKey) {
    return { ok: false, field: 'privateKey' };
  }
  return {
    ok: true,
    value: {
      v: 1, kind: 'connector_proof_key', principal: record.principal, generation: record.generation,
      publicKey: record.publicKey, privateKey: record.privateKey,
    },
  };
}

export function encodeInternalConnectorKey(value: InternalConnectorKey): string {
  const text = `${JSON.stringify({
    v: 1, kind: 'connector_proof_key', principal: value.principal, generation: value.generation,
    publicKey: value.publicKey, privateKey: value.privateKey,
  })}\n`;
  if (!parseInternalConnectorKey(text).ok) throw new TypeError('internal connector key: invalid');
  return text;
}
