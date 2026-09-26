import type { BindingId, EventRef } from '@khala/contracts/delivery/index';

export function wellFormed(value: string): boolean {
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

export function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512
    && wellFormed(value) && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function validBindingArgument(value: unknown): value is BindingId {
  return validIdentifier(value);
}
export function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
export function validEventRef(value: unknown): value is EventRef {
  if (!plainObject(value)) return false;
  const keys = ['v', 'roomId', 'eventId', 'authorParticipantId', 'authorDeviceId', 'contentDigest'];
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && value.v === 1 && validIdentifier(value.roomId) && validIdentifier(value.eventId)
    && validIdentifier(value.authorParticipantId) && validIdentifier(value.authorDeviceId)
    && validDigest(value.contentDigest);
}
/** True when `value` has exactly these own keys, no more and no fewer. */
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}
