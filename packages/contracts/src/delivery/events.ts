// Immutable event references selected for release. Rendering and transport SDK
// objects are intentionally outside this delivery contract.

import {
  type Decoded, type DeliveryLimits, array, decodeWith, elementField, fail, identifier, object, version,
} from './decode';
import { type DeviceId, type EventId, type ParticipantId, type RoomId, readId } from './ids';

export type EventRef = Readonly<{
  v: 1;
  roomId: RoomId;
  eventId: EventId;
  authorParticipantId: ParticipantId;
  authorDeviceId: DeviceId;
  contentDigest: string;
}>;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function readSha256Digest(input: unknown, field: string): string {
  const value = identifier(input, field);
  if (!SHA256_DIGEST.test(value)) fail(field, 'invalid_field');
  return value;
}

export function decodeEventRef(input: unknown): Decoded<EventRef> {
  return decodeWith(() => readEventRef(input, ''));
}

export function readEventRef(input: unknown, field: string): EventRef {
  const reader = object(input, field, [
    'v', 'roomId', 'eventId', 'authorParticipantId', 'authorDeviceId', 'contentDigest',
  ]);
  return {
    v: version(reader.field('v'), reader.at('v')),
    roomId: readId<'RoomId'>(reader.field('roomId'), reader.at('roomId')),
    eventId: readId<'EventId'>(reader.field('eventId'), reader.at('eventId')),
    authorParticipantId: readId<'ParticipantId'>(
      reader.field('authorParticipantId'),
      reader.at('authorParticipantId'),
    ),
    authorDeviceId: readId<'DeviceId'>(reader.field('authorDeviceId'), reader.at('authorDeviceId')),
    contentDigest: readSha256Digest(reader.field('contentDigest'), reader.at('contentDigest')),
  };
}

/** Event identity is the room/event pair; attribution and digest remain bound separately. */
export function sameEventIdentity(a: EventRef, b: EventRef): boolean {
  return a.roomId === b.roomId && a.eventId === b.eventId;
}

/** Exact equality of every immutable reference field. */
export function sameEventRef(a: EventRef, b: EventRef): boolean {
  return a.v === b.v
    && sameEventIdentity(a, b)
    && a.authorParticipantId === b.authorParticipantId
    && a.authorDeviceId === b.authorDeviceId
    && a.contentDigest === b.contentDigest;
}

export function decodeEventSelection(input: unknown, limits: DeliveryLimits): Decoded<readonly EventRef[]> {
  return decodeWith(() => readEventSelection(input, '', limits));
}

/**
 * Reads one exact, ordered single-room selection. Identity duplicates are refused
 * rather than collapsed, and arrays exceeding capability are refused rather than
 * truncated.
 */
export function readEventSelection(input: unknown, field: string, limits: DeliveryLimits): readonly EventRef[] {
  const values = array(input, field);
  if (values.length === 0) fail(field, 'invalid_field');
  if (values.length > limits.maxSelectionEvents) fail(field, 'limit_exceeded');

  const events = values.map((value, index) => readEventRef(value, elementField(field, index)));
  const roomId = events[0]!.roomId;
  const eventIds = new Set<EventId>();
  events.forEach((event, index) => {
    const itemField = elementField(field, index);
    if (event.roomId !== roomId) fail(`${itemField}.roomId`, 'invalid_field');
    if (eventIds.has(event.eventId)) fail(`${itemField}.eventId`, 'invalid_field');
    eventIds.add(event.eventId);
  });
  return events;
}
