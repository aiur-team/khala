// Branded opaque identifiers. Each kind is a plain string at runtime, but the type
// system refuses a `DeviceId` where an `OwnerId` is expected. The brand is keyed by a
// string literal, so an independently declared mirror (KHA-106) stays structurally
// compatible without importing this domain.

import { type Decoded, decodeWith, identifier } from './decode';

export type IdKind = 'OwnerId' | 'ParticipantId' | 'DeviceId' | 'BindingId' | 'RoomId' | 'EventId';

export type Id<Kind extends IdKind> = string & { readonly __khala: Kind };

export type OwnerId = Id<'OwnerId'>;
export type ParticipantId = Id<'ParticipantId'>;
export type DeviceId = Id<'DeviceId'>;
export type BindingId = Id<'BindingId'>;
export type RoomId = Id<'RoomId'>;
export type EventId = Id<'EventId'>;

/** Reads an opaque identifier and brands it; used by every decoder in this domain. */
export function readId<Kind extends IdKind>(input: unknown, path: string): Id<Kind> {
  return identifier(input, path) as Id<Kind>;
}

const idDecoder = <Kind extends IdKind>() => (input: unknown): Decoded<Id<Kind>> => decodeWith(() => readId<Kind>(input, ''));

/** Entry points for identifiers that arrive alone, such as route parameters. */
export const decodeOwnerId = idDecoder<'OwnerId'>();
export const decodeParticipantId = idDecoder<'ParticipantId'>();
export const decodeDeviceId = idDecoder<'DeviceId'>();
export const decodeBindingId = idDecoder<'BindingId'>();
export const decodeRoomId = idDecoder<'RoomId'>();
export const decodeEventId = idDecoder<'EventId'>();
