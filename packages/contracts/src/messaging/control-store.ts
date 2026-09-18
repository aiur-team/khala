// Guarded account/membership/control metadata. Atomicity is per key: there is no
// cross-key transaction. Messaging history and keys never live here.

import { type Decoded, decodeWith, fail, identifier, nullable, object, utcTimestamp } from './decode';
import type { CallOptions } from './outcomes';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ControlRecord<T extends JsonValue = JsonValue> = Readonly<{
  key: string;
  /** Opaque, provider-assigned; changes on every applied write. */
  revision: string;
  /** Identity of the write that produced this revision. */
  operationId: string;
  value: T;
  /** UTC RFC 3339. Enforced at lookup against trusted time; no cleanup job is assumed. */
  expiresAt: string | null;
}>;

/** A store failure is `unavailable`, never `absent`. Expired records read as `absent`. */
export type ControlRead<T extends JsonValue = JsonValue> =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; record: ControlRecord<T> }>
  | Readonly<{ kind: 'unavailable' }>;

export type CompareAndSetInput<T extends JsonValue = JsonValue> = Readonly<{
  key: string;
  /** `null` creates only if absent (or expired). */
  expectedRevision: string | null;
  operationId: string;
  next: Readonly<{ value: T; expiresAt: string | null }>;
}>;

/**
 * - `applied`: this operation's write is the record (also returned when an
 *   identical retry finds its own write already applied).
 * - `conflict`: the expected revision did not match; `current` is what was found.
 * - `operation_mismatch`: the operation ID was already used for another key or
 *   different bytes. An operation ID never names two different writes.
 * - `outcome_unknown`: the write may have landed. Call `resolve`; do not retry
 *   with new bytes.
 * - `unavailable`: nothing was written.
 */
export type WriteResult<T extends JsonValue = JsonValue> =
  | Readonly<{ kind: 'applied'; record: ControlRecord<T> }>
  | Readonly<{ kind: 'conflict'; current: ControlRecord<T> | null }>
  | Readonly<{ kind: 'operation_mismatch' }>
  | Readonly<{ kind: 'outcome_unknown'; operationId: string }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Result of resolving an earlier write by operation ID. `not_applied` is a proof
 * that the write did not land and may be retried with the same operation and bytes;
 * `outcome_unknown` means the provider cannot prove either way, and callers keep
 * that uncertainty rather than guessing.
 */
export type ResolveResult<T extends JsonValue = JsonValue> =
  | Readonly<{ kind: 'applied'; record: ControlRecord<T> }>
  | Readonly<{ kind: 'not_applied' }>
  | Readonly<{ kind: 'outcome_unknown'; operationId: string }>
  | Readonly<{ kind: 'unavailable' }>;

export interface ControlStore {
  read<T extends JsonValue>(key: string, options?: CallOptions): Promise<ControlRead<T>>;
  compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>, options?: CallOptions): Promise<WriteResult<T>>;
  resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>, options?: CallOptions): Promise<ResolveResult<T>>;
}

/** Trusted clock injected into store implementations, in epoch milliseconds. */
export type TrustedClock = () => number;

/** A record authorises reads only strictly before its expiry. */
export function isRecordLive(record: Pick<ControlRecord, 'expiresAt'>, nowMs: number): boolean {
  return record.expiresAt === null || nowMs < Date.parse(record.expiresAt);
}

/** Structural JSON equality; object key order is irrelevant, array order is not. */
export function sameJsonValue(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value: JsonValue, index: number) => sameJsonValue(value, b[index] as JsonValue));
  }
  const left = a as { readonly [key: string]: JsonValue };
  const right = b as { readonly [key: string]: JsonValue };
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key] as JsonValue, right[key] as JsonValue));
}

/** Decodes a record envelope. The value is checked to be JSON only; its schema belongs to the key's owner. */
export function decodeControlRecord(input: unknown): Decoded<ControlRecord> {
  return decodeWith(() => {
    const r = object(input, '', ['key', 'revision', 'operationId', 'value', 'expiresAt']);
    const value = r.field('value');
    if (!isJsonValue(value)) fail(r.at('value'), 'wrong_type');
    return {
      key: identifier(r.field('key'), r.at('key')),
      revision: identifier(r.field('revision'), r.at('revision')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      value,
      expiresAt: nullable(r.field('expiresAt'), expiry => utcTimestamp(expiry, r.at('expiresAt'))),
    };
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJsonValue);
}
