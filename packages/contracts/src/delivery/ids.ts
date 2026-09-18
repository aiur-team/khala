// These brands deliberately use the same structural key and literal names as
// their independent peers. Shared wire identifiers therefore compose across
// packages without either contract subtree importing the other.

import { type Decoded, decodeWith, identifier } from './decode';

export type IdKind =
  | 'OwnerId'
  | 'ParticipantId'
  | 'DeviceId'
  | 'BindingId'
  | 'RoomId'
  | 'EventId'
  | 'CommandId'
  | 'ReleaseId'
  | 'ReceiptId'
  | 'AuthorizationId'
  | 'OperationId'
  | 'CausalRootId';

export type Id<Kind extends IdKind> = string & { readonly __khala: Kind };

export type OwnerId = Id<'OwnerId'>;
export type ParticipantId = Id<'ParticipantId'>;
export type DeviceId = Id<'DeviceId'>;
export type BindingId = Id<'BindingId'>;
export type RoomId = Id<'RoomId'>;
export type EventId = Id<'EventId'>;
export type CommandId = Id<'CommandId'>;
export type ReleaseId = Id<'ReleaseId'>;
export type ReceiptId = Id<'ReceiptId'>;
export type AuthorizationId = Id<'AuthorizationId'>;
export type OperationId = Id<'OperationId'>;
export type CausalRootId = Id<'CausalRootId'>;

export function readId<Kind extends IdKind>(input: unknown, field: string): Id<Kind> {
  return identifier(input, field) as Id<Kind>;
}

const idDecoder = <Kind extends IdKind>() => (input: unknown): Decoded<Id<Kind>> =>
  decodeWith(() => readId<Kind>(input, ''));

export const decodeOwnerId = idDecoder<'OwnerId'>();
export const decodeParticipantId = idDecoder<'ParticipantId'>();
export const decodeDeviceId = idDecoder<'DeviceId'>();
export const decodeBindingId = idDecoder<'BindingId'>();
export const decodeRoomId = idDecoder<'RoomId'>();
export const decodeEventId = idDecoder<'EventId'>();
export const decodeCommandId = idDecoder<'CommandId'>();
export const decodeReleaseId = idDecoder<'ReleaseId'>();
export const decodeReceiptId = idDecoder<'ReceiptId'>();
export const decodeAuthorizationId = idDecoder<'AuthorizationId'>();
export const decodeOperationId = idDecoder<'OperationId'>();
export const decodeCausalRootId = idDecoder<'CausalRootId'>();
