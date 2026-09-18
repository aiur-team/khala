// Strict, dependency-free decoding primitives shared by the messaging contracts.
// Decoders accept `unknown` and either return a typed value or a located error;
// they never coerce, normalise or drop fields.

export type DecodeErrorCode =
  | 'not_object'
  | 'unknown_field'
  | 'missing_field'
  | 'wrong_type'
  | 'empty'
  | 'too_long'
  | 'control_character'
  | 'malformed_unicode'
  | 'unsupported_version'
  | 'unsafe_integer'
  | 'invalid_value'
  | 'duplicate'
  | 'mismatch';

export type DecodeError = Readonly<{ path: string; code: DecodeErrorCode }>;

export type Decoded<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: DecodeError }>;

/** Maximum UTF-8 size of any opaque identifier. */
export const MAX_IDENTIFIER_BYTES = 512;

/**
 * Size limits declared by the selected substrate's capability record. No universal
 * protocol limit is assumed here; callers pass what their substrate supports.
 */
export type ContentLimits = Readonly<{
  maxBodyBytes: number;
  maxDisplayNameBytes: number;
  maxRoomTitleBytes: number;
}>;

export class DecodeFailure extends Error {
  readonly path: string;
  readonly code: DecodeErrorCode;
  constructor(path: string, code: DecodeErrorCode) {
    super(`${path || '<root>'}: ${code}`);
    this.name = 'DecodeFailure';
    this.path = path;
    this.code = code;
  }
}

export function fail(path: string, code: DecodeErrorCode): never {
  throw new DecodeFailure(path, code);
}

/** Runs a throwing reader and converts the first failure into a `Decoded` result. */
export function decodeWith<T>(read: () => T): Decoded<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof DecodeFailure) return { ok: false, error: { path: error.path, code: error.code } };
    throw error;
  }
}

const join = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

export type Reader = Readonly<{
  path: string;
  field: (key: string) => unknown;
  at: (key: string) => string;
}>;

/** Requires a plain object carrying exactly `keys`; extra or missing keys fail. */
export function object(input: unknown, path: string, keys: readonly string[]): Reader {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(path, 'not_object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'not_object');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(join(path, key), 'unknown_field');
  for (const key of keys) if (!Object.hasOwn(record, key)) fail(join(path, key), 'missing_field');
  return { path, field: key => record[key], at: key => join(path, key) };
}

export function array(input: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(input)) fail(path, 'wrong_type');
  return input;
}

export function elementPath(path: string, index: number): string {
  return join(path, index);
}

export function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** True when the string contains no unpaired UTF-16 surrogate. */
export function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Well-formed string within a UTF-8 byte limit; content may contain newlines and tabs. */
export function text(input: unknown, path: string, maxBytes: number): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!isWellFormed(input)) fail(path, 'malformed_unicode');
  if (utf8Length(input) > maxBytes) fail(path, 'too_long');
  if (input.includes('\u0000')) fail(path, 'control_character');
  return input;
}

/** Single-line label (display name, title): no control characters at all. */
export function label(input: unknown, path: string, maxBytes: number): string {
  const value = text(input, path, maxBytes);
  if (CONTROL.test(value)) fail(path, 'control_character');
  return value;
}

/**
 * Opaque protocol identifier. Returned byte-for-byte: never trimmed, lowercased,
 * normalised or mapped to an invented UUID.
 */
export function identifier(input: unknown, path: string): string {
  const value = label(input, path, MAX_IDENTIFIER_BYTES);
  if (value.length === 0) fail(path, 'empty');
  return value;
}

export function nullable<T>(input: unknown, read: (value: unknown) => T): T | null {
  return input === null ? null : read(input);
}

export function literal<const T extends string | number>(input: unknown, path: string, allowed: readonly T[]): T {
  if (!allowed.includes(input as T)) fail(path, typeof input === typeof allowed[0] ? 'invalid_value' : 'wrong_type');
  return input as T;
}

export function version(input: unknown, path: string): 1 {
  if (input !== 1) fail(path, 'unsupported_version');
  return 1;
}

/** Nonnegative integer within the IEEE-754 safe range. */
export function safeInteger(input: unknown, path: string): number {
  if (typeof input !== 'number') fail(path, 'wrong_type');
  if (!Number.isSafeInteger(input)) fail(path, 'unsafe_integer');
  if (input < 0) fail(path, 'invalid_value');
  return input;
}

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** UTC RFC 3339 timestamp with a `Z` suffix; calendar-invalid dates fail. */
export function utcTimestamp(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  const match = UTC_TIMESTAMP.exec(input);
  if (!match) fail(path, 'invalid_value');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  // setUTCFullYear avoids Date.UTC mapping years 0-99 onto 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) fail(path, 'invalid_value');
  return input;
}
