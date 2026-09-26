// Public bootstrap descriptors. A link descriptor names an invite, the ownership
// methods the service accepts and the service's fixed endpoints. A pairing
// descriptor is fetched for a human-entered code from the configured hosted
// origin and names only the fixed pairing endpoints. Both are data only: nothing
// in them can select an executable, widen permissions or point the connector at
// another origin.

import { createHash } from 'node:crypto';

/** Paths are fixed by protocol version; the descriptor only confirms them. */
export const DESCRIPTOR_PATH = '/api/agent/bootstrap/descriptor';
export const AUTHORIZE_PATH = '/api/human/agent-bootstrap/authorize';
export const TOKEN_PATH = '/api/agent/bootstrap/token';
export const REDEEM_PATH = '/api/agent/bootstrap/redeem';
export const PAIRING_CLAIM_PATH = '/api/agent/pairing/claim';
export const PAIRING_RESULT_PATH = '/api/agent/pairing/result';

/**
 * Ownership methods this protocol version defines. KHA-144 proved
 * `loopback-browser-v1`; `pairing-code-v1` is the code-only cross-machine method.
 */
export const OWNERSHIP_METHODS = ['loopback-browser-v1', 'pairing-code-v1'] as const;
export type OwnershipMethod = (typeof OWNERSHIP_METHODS)[number];
/** Methods a channel link can complete. A link never carries a pairing code. */
export const LINK_OWNERSHIP_METHODS: readonly OwnershipMethod[] = ['loopback-browser-v1'];
export const PAIRING_METHOD = 'pairing-code-v1' as const;

export const DESCRIPTOR_MEDIA_TYPE = 'application/json';
/** Largest descriptor body accepted, in bytes. A descriptor is a few hundred bytes. */
export const MAX_DESCRIPTOR_BYTES = 4096;
export const MAX_INVITE_BYTES = 512;

export type BootstrapDescriptor = Readonly<{
  v: 1;
  /** Opaque invite reference; never an owner, channel or secret. */
  invite: string;
  /** Known methods only, in the service's order; unknown identifiers are dropped. */
  methods: readonly OwnershipMethod[];
  authorize: string;
  token: string;
  redeem: string;
}>;

export type DescriptorFailure = 'malformed' | 'unsupported_version' | 'foreign_endpoint' | 'no_supported_method';

export type DescriptorDecode =
  | Readonly<{ kind: 'ok'; descriptor: BootstrapDescriptor }>
  | Readonly<{ kind: 'invalid'; code: DescriptorFailure }>;

const KEYS = ['v', 'invite', 'methods', 'authorize', 'token', 'redeem'];
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

/**
 * Strictly decodes a descriptor fetched for a link on `origin`. Unknown keys fail,
 * so a newer or hostile document cannot smuggle directives past this version.
 */
export function decodeDescriptor(input: unknown, origin: string): DescriptorDecode {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid('malformed');
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!Object.hasOwn(record, 'v')) return invalid('malformed');
  if (record.v !== 1) return invalid('unsupported_version');
  if (keys.length !== KEYS.length || !keys.every(key => KEYS.includes(key))) return invalid('malformed');
  const { invite, methods } = record;
  if (typeof invite !== 'string' || invite.length === 0 || Buffer.byteLength(invite) > MAX_INVITE_BYTES
    || INVISIBLE.test(invite) || invite.trim() !== invite) return invalid('malformed');
  if (!Array.isArray(methods) || methods.length === 0 || methods.length > 16
    || !methods.every(method => typeof method === 'string' && method.length <= 64)) return invalid('malformed');
  const endpoints = { authorize: AUTHORIZE_PATH, token: TOKEN_PATH, redeem: REDEEM_PATH } as const;
  for (const [key, path] of Object.entries(endpoints)) {
    const value = record[key];
    if (typeof value !== 'string') return invalid('malformed');
    if (value !== `${origin}${path}`) return invalid('foreign_endpoint');
  }
  const known = (methods as string[]).filter((method): method is OwnershipMethod => (OWNERSHIP_METHODS as readonly string[]).includes(method));
  if (known.length === 0) return invalid('no_supported_method');
  return {
    kind: 'ok',
    descriptor: {
      v: 1,
      invite,
      methods: [...new Set(known)],
      authorize: `${origin}${AUTHORIZE_PATH}`,
      token: `${origin}${TOKEN_PATH}`,
      redeem: `${origin}${REDEEM_PATH}`,
    },
  };
}

/** Code-only descriptor from the configured hosted origin. */
export type PairingDescriptor = Readonly<{
  v: 1;
  claim: string;
  result: string;
  redeem: string;
  /** Canonical digest of this decoded descriptor; it participates in the operation fingerprint. */
  id: string;
}>;

export type PairingDescriptorDecode =
  | Readonly<{ kind: 'ok'; descriptor: PairingDescriptor }>
  | Readonly<{ kind: 'invalid'; code: DescriptorFailure }>;

const PAIRING_KEYS = ['v', 'methods', 'claim', 'result', 'redeem'];

/**
 * Strictly decodes the code-only descriptor fetched from `origin`. Every endpoint
 * must be that origin's fixed path, so the response cannot move the claim, the
 * approval wait or the redeem anywhere else.
 */
export function decodePairingDescriptor(input: unknown, origin: string): PairingDescriptorDecode {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { kind: 'invalid', code: 'malformed' };
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!Object.hasOwn(record, 'v')) return { kind: 'invalid', code: 'malformed' };
  if (record.v !== 1) return { kind: 'invalid', code: 'unsupported_version' };
  if (keys.length !== PAIRING_KEYS.length || !keys.every(key => PAIRING_KEYS.includes(key))) return { kind: 'invalid', code: 'malformed' };
  const { methods } = record;
  if (!Array.isArray(methods) || methods.length === 0 || methods.length > 16
    || !methods.every(method => typeof method === 'string' && method.length <= 64)) return { kind: 'invalid', code: 'malformed' };
  const endpoints = { claim: PAIRING_CLAIM_PATH, result: PAIRING_RESULT_PATH, redeem: REDEEM_PATH } as const;
  for (const [key, path] of Object.entries(endpoints)) {
    const value = record[key];
    if (typeof value !== 'string') return { kind: 'invalid', code: 'malformed' };
    if (value !== `${origin}${path}`) return { kind: 'invalid', code: 'foreign_endpoint' };
  }
  if (!methods.includes(PAIRING_METHOD)) return { kind: 'invalid', code: 'no_supported_method' };
  const claim = `${origin}${PAIRING_CLAIM_PATH}`;
  const result = `${origin}${PAIRING_RESULT_PATH}`;
  const redeem = `${origin}${REDEEM_PATH}`;
  const id = createHash('sha256')
    .update(JSON.stringify(['khala.pairing.descriptor.v1', origin, PAIRING_METHOD, claim, result, redeem]))
    .digest('base64url');
  return { kind: 'ok', descriptor: { v: 1, claim, result, redeem, id } };
}

function invalid(code: DescriptorFailure): DescriptorDecode {
  return { kind: 'invalid', code };
}
