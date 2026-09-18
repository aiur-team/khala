// Strict, dependency-free decoding primitives for delivery contracts. This
// subtree mirrors shared wire validation without importing another domain.

export type DecodeErrorCode = 'invalid_version' | 'invalid_field' | 'limit_exceeded';

export type DeliveryDecodeErrorCode = DecodeErrorCode;

export type DeliveryDecodeError = Readonly<{
  code: DeliveryDecodeErrorCode;
  field: string;
}>;

export type Decoded<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: DecodeErrorCode; field: string }>;

/** Maximum UTF-8 size of every opaque protocol identifier. */
export const MAX_IDENTIFIER_BYTES = 512;

/**
 * Limits supplied by the selected deployment/harness capability. There are no
 * protocol defaults: callers must decode an explicit configuration first.
 */
export type DeliveryLimits = Readonly<{
  maxSelectionEvents: number;
  maxPayloadBytes: number;
}> & { readonly __khala: 'DeliveryLimits' };

export class DecodeFailure extends Error {
  readonly code: DecodeErrorCode;
  readonly field: string;

  constructor(field: string, code: DecodeErrorCode) {
    super(`${field || '<root>'}: ${code}`);
    this.name = 'DecodeFailure';
    this.code = code;
    this.field = field;
  }
}

export function fail(field: string, code: DecodeErrorCode): never {
  throw new DecodeFailure(field, code);
}

/** Converts a throwing reader into the public, plaintext-free total result. */
export function decodeWith<T>(read: () => T): Decoded<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof DecodeFailure) return { ok: false, code: error.code, field: error.field };
    // Exotic objects (proxies/getters) can throw while being inspected. They are
    // invalid input too; never leak their thrown message or make a decoder throw.
    return { ok: false, code: 'invalid_field', field: '' };
  }
}

const join = (field: string, key: string | number): string =>
  typeof key === 'number' ? `${field}[${key}]` : field ? `${field}.${key}` : key;

export function elementField(field: string, index: number): string {
  return join(field, index);
}

export type Reader = Readonly<{
  field: (key: string) => unknown;
  at: (key: string) => string;
}>;

/** Requires a plain object carrying exactly the listed fields. */
export function object(input: unknown, field: string, fields: readonly string[]): Reader {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(field, 'invalid_field');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(field, 'invalid_field');

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) fail(join(field, key), 'invalid_field');
  }
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) fail(join(field, key), 'invalid_field');
  }
  return {
    field: key => {
      try {
        return record[key];
      } catch {
        fail(join(field, key), 'invalid_field');
      }
    },
    at: key => join(field, key),
  };
}

export function array(input: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(input)) fail(field, 'invalid_field');
  return input;
}

export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** True only when every UTF-16 surrogate belongs to a valid pair. */
export function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Byte-exact, nonempty opaque identifier with no control characters. */
export function identifier(input: unknown, field: string): string {
  if (typeof input !== 'string') fail(field, 'invalid_field');
  if (!isWellFormed(input) || input.length === 0 || CONTROL.test(input)) fail(field, 'invalid_field');
  if (utf8Length(input) > MAX_IDENTIFIER_BYTES) fail(field, 'limit_exceeded');
  return input;
}

export function literal<const T extends string | number | boolean>(
  input: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(input as T)) fail(field, 'invalid_field');
  return input as T;
}

export function version(input: unknown, field: string): 1 {
  if (input !== 1) fail(field, 'invalid_version');
  return 1;
}

/** Nonnegative integer within the IEEE-754 safe range. */
export function safeInteger(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) fail(field, 'invalid_field');
  return input;
}

export function booleanValue(input: unknown, field: string): boolean {
  if (typeof input !== 'boolean') fail(field, 'invalid_field');
  return input;
}

export function nullable<T>(input: unknown, read: (value: unknown) => T): T | null {
  return input === null ? null : read(input);
}

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** UTC RFC 3339 timestamp with a `Z` suffix; calendar-invalid dates fail. */
export function utcTimestamp(input: unknown, field: string): string {
  if (typeof input !== 'string') fail(field, 'invalid_field');
  const match = UTC_TIMESTAMP.exec(input);
  if (!match) fail(field, 'invalid_field');
  const parts = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) fail(field, 'invalid_field');
  return input;
}

export function decodeDeliveryLimits(input: unknown): Decoded<DeliveryLimits> {
  return decodeWith(() => readDeliveryLimits(input, ''));
}

export function readDeliveryLimits(input: unknown, field: string): DeliveryLimits {
  const reader = object(input, field, ['maxSelectionEvents', 'maxPayloadBytes']);
  const positiveLimit = (key: 'maxSelectionEvents' | 'maxPayloadBytes'): number => {
    const value = safeInteger(reader.field(key), reader.at(key));
    if (value === 0) fail(reader.at(key), 'invalid_field');
    return value;
  };
  return {
    maxSelectionEvents: positiveLimit('maxSelectionEvents'),
    maxPayloadBytes: positiveLimit('maxPayloadBytes'),
  } as DeliveryLimits;
}
