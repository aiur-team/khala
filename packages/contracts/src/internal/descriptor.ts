// Versioned runtime descriptor for internal mode. The launcher publishes it as
// the owner-private root `active.json`; installed local clients re-read that one
// file for the current loopback origin and launch-scoped capabilities. The value
// is a closed union: transport-only discovery, or discovery plus one complete
// human-granted binding. There is no partially granted state.
//
// This module is pure and dependency-free so both the application writer and
// the agent CLI reader can import it without crossing a runtime boundary.

export const INTERNAL_DESCRIPTOR_VERSION = 1;

/** Stable descriptor file name below the private internal root. */
export const INTERNAL_ACTIVE_DESCRIPTOR_FILE = 'active.json';

/** Largest descriptor a reader accepts, in UTF-8 bytes. */
export const MAX_INTERNAL_DESCRIPTOR_BYTES = 4_096;

/** Largest opaque identifier (channel, grant, binding) in UTF-8 bytes. */
export const MAX_INTERNAL_IDENTIFIER_BYTES = 512;

/**
 * Directory that holds the built internal browser bundle. The internal web build
 * emits into `apps/web/dist/<name>/` and the packaged CLI ships it as
 * `dist/<name>/` beside `khala.js`. Its root must contain
 * `INTERNAL_WEB_BUNDLE_DOCUMENT`, which the local server serves for `/` and for
 * `/channels/:channelId`.
 */
export const INTERNAL_WEB_BUNDLE_DIRECTORY = 'internal-web';
export const INTERNAL_WEB_BUNDLE_DOCUMENT = 'index.html';

/** Loopback discovery only: permits no channel read or send by itself. */
export type TransportDescriptor = Readonly<{
  v: 1;
  channelId: string;
  /** Exactly `http://127.0.0.1:<port>`. */
  origin: string;
  transportCapability: string;
}>;

/** Discovery plus the launch-scoped authority of one durable human grant. */
export type GrantedDescriptor = Readonly<TransportDescriptor & {
  grantRef: string;
  bindingId: string;
  bindingCapability: string;
}>;

export type InternalDescriptor = TransportDescriptor | GrantedDescriptor;

export type InternalDescriptorErrorCode =
  | 'too_large'
  | 'malformed_json'
  | 'not_object'
  | 'unknown_field'
  | 'missing_field'
  | 'unsupported_version'
  | 'invalid_value';

export type InternalDescriptorError = Readonly<{ code: InternalDescriptorErrorCode; field: string }>;

export type DecodedInternalDescriptor =
  | Readonly<{ ok: true; value: InternalDescriptor }>
  | Readonly<{ ok: false; error: InternalDescriptorError }>;

const TRANSPORT_KEYS = ['v', 'channelId', 'origin', 'transportCapability'] as const;
const GRANT_KEYS = ['grantRef', 'bindingId', 'bindingCapability'] as const;
const ALL_KEYS: readonly string[] = [...TRANSPORT_KEYS, ...GRANT_KEYS];

// 32 random bytes as unpadded base64url: 42 free characters, then a final
// character whose low two bits are zero so the encoding is canonical.
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Canonical unpadded base64url encoding of exactly 32 bytes. */
export function isInternalCapability(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_PATTERN.test(value);
}

/** `http://127.0.0.1:<port>` with a canonical decimal port in 1..65535. */
export function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ORIGIN_PATTERN.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

export function loopbackOrigin(port: number): string {
  const origin = `http://127.0.0.1:${port}`;
  if (!Number.isSafeInteger(port) || !isLoopbackOrigin(origin)) throw new RangeError('loopback origin: invalid port');
  return origin;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Nonempty, well-formed, single-line and bounded; returned byte-for-byte. */
export function isInternalIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !CONTROL.test(value) && !/\p{Cs}/u.test(value)
    && utf8Length(value) <= MAX_INTERNAL_IDENTIFIER_BYTES;
}

class Failure extends Error {
  constructor(readonly code: InternalDescriptorErrorCode, readonly field: string) {
    super(`${field || '<root>'}: ${code}`);
  }
}

function read(input: unknown): InternalDescriptor {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Failure('not_object', '');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Failure('not_object', '');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!ALL_KEYS.includes(key)) throw new Failure('unknown_field', key);
  for (const key of TRANSPORT_KEYS) if (!Object.hasOwn(record, key)) throw new Failure('missing_field', key);
  if (record.v !== INTERNAL_DESCRIPTOR_VERSION) throw new Failure('unsupported_version', 'v');
  if (!isInternalIdentifier(record.channelId)) throw new Failure('invalid_value', 'channelId');
  if (!isLoopbackOrigin(record.origin)) throw new Failure('invalid_value', 'origin');
  if (!isInternalCapability(record.transportCapability)) throw new Failure('invalid_value', 'transportCapability');
  const transport: TransportDescriptor = {
    v: 1, channelId: record.channelId, origin: record.origin, transportCapability: record.transportCapability,
  };
  const present = GRANT_KEYS.filter(key => Object.hasOwn(record, key));
  if (present.length === 0) return transport;
  // A grant is all three fields or none: a half-written grant is never authority.
  const missing = GRANT_KEYS.find(key => !Object.hasOwn(record, key));
  if (missing) throw new Failure('missing_field', missing);
  if (!isInternalIdentifier(record.grantRef)) throw new Failure('invalid_value', 'grantRef');
  if (!isInternalIdentifier(record.bindingId)) throw new Failure('invalid_value', 'bindingId');
  if (!isInternalCapability(record.bindingCapability)) throw new Failure('invalid_value', 'bindingCapability');
  // Distinct secrets per role: a binding capability never doubles as transport.
  if (record.bindingCapability === record.transportCapability) throw new Failure('invalid_value', 'bindingCapability');
  return { ...transport, grantRef: record.grantRef, bindingId: record.bindingId, bindingCapability: record.bindingCapability };
}

/** Strictly decodes an already-parsed value; never coerces or drops fields. */
export function decodeInternalDescriptor(input: unknown): DecodedInternalDescriptor {
  try {
    return { ok: true, value: read(input) };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, error: { code: error.code, field: error.field } };
    throw error;
  }
}

/** Decodes exact file text, enforcing the size bound before parsing. */
export function parseInternalDescriptor(text: string): DecodedInternalDescriptor {
  if (typeof text !== 'string' || utf8Length(text) > MAX_INTERNAL_DESCRIPTOR_BYTES) {
    return { ok: false, error: { code: 'too_large', field: '' } };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'malformed_json', field: '' } };
  }
  return decodeInternalDescriptor(value);
}

export function isGrantedDescriptor(descriptor: InternalDescriptor): descriptor is GrantedDescriptor {
  return 'bindingCapability' in descriptor;
}

/** Canonical file text with fixed key order; refuses anything the decoder would reject. */
export function encodeInternalDescriptor(descriptor: InternalDescriptor): string {
  const checked = decodeInternalDescriptor(descriptor);
  if (!checked.ok) throw new TypeError(`internal descriptor: ${checked.error.code} ${checked.error.field}`.trim());
  const value = checked.value;
  const ordered = isGrantedDescriptor(value)
    ? {
      v: value.v, channelId: value.channelId, origin: value.origin, transportCapability: value.transportCapability,
      grantRef: value.grantRef, bindingId: value.bindingId, bindingCapability: value.bindingCapability,
    }
    : { v: value.v, channelId: value.channelId, origin: value.origin, transportCapability: value.transportCapability };
  const text = `${JSON.stringify(ordered)}\n`;
  if (utf8Length(text) > MAX_INTERNAL_DESCRIPTOR_BYTES) throw new TypeError('internal descriptor: too_large');
  return text;
}
