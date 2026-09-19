import type { EventRef } from '@khala/contracts/delivery/index';

export function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
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
export function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
