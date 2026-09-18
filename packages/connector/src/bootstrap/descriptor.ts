// Public bootstrap descriptor served for a chat link. It names an invite, the
// ownership methods the service accepts and the service's fixed endpoints. It is
// data only: nothing in it can select an executable, widen permissions or point
// the connector at another origin.

/** Paths are fixed by protocol version; the descriptor only confirms them. */
export const DESCRIPTOR_PATH = '/api/agent/bootstrap/descriptor';
export const AUTHORIZE_PATH = '/api/human/agent-bootstrap/authorize';
export const TOKEN_PATH = '/api/agent/bootstrap/token';
export const REDEEM_PATH = '/api/agent/bootstrap/redeem';

/** Ownership methods this protocol version defines. KHA-144 proved `loopback-browser-v1`. */
export const OWNERSHIP_METHODS = ['loopback-browser-v1'] as const;
export type OwnershipMethod = (typeof OWNERSHIP_METHODS)[number];

export const DESCRIPTOR_MEDIA_TYPE = 'application/json';
/** Largest descriptor body accepted, in bytes. A descriptor is a few hundred bytes. */
export const MAX_DESCRIPTOR_BYTES = 4096;
export const MAX_INVITE_BYTES = 512;

export type BootstrapDescriptor = Readonly<{
  v: 1;
  /** Opaque invite reference; never an owner, room or secret. */
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

function invalid(code: DescriptorFailure): DescriptorDecode {
  return { kind: 'invalid', code };
}
