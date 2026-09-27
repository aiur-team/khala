// P13 channel closure is an owner-authorized lifecycle operation. It ends this
// owner's participation; it does not erase transport or recipient copies.

import { type Decoded, decodeWith, fail, identifier, literal, object, safeInteger } from './decode';
import { type OwnerId, type RoomId, readId } from './ids';
import type { CallOptions, OperationResult } from './outcomes';

export const CLOSURE_CONSEQUENCES = Object.freeze({
  stopsNewMessages: true,
  removesFromOwnerView: true,
  requestsLocalCleanup: true,
  recallsDeliveredCopies: false,
} as const);

export type ClosureConsequences = typeof CLOSURE_CONSEQUENCES;
export type ClosureUnavailableReason = 'not_configured' | 'forbidden' | 'stale_room' | 'signed_out';
export type ClosureFailureReason = 'forbidden' | 'stale_room' | 'dependency_unavailable' | 'local_cleanup_failed';

export type ClosureCapability = Readonly<{
  ownerId: OwnerId;
  roomId: RoomId;
  /** Monotonic owner/channel generation; never an opaque transport revision. */
  expectedRoomRevision: number;
  available: boolean;
  unavailableReason: ClosureUnavailableReason | null;
  consequences: ClosureConsequences;
}>;

export type ClosureRequest = Readonly<{
  /** Stable across retries and outcome inspection. Bound to owner, room and generation. */
  operationId: string;
  ownerId: OwnerId;
  roomId: RoomId;
  expectedRoomRevision: number;
}>;

export type ClosureStatus = Readonly<{
  operationId: string;
  /** Partial means participation ended but local cleanup remains unconfirmed. */
  state: 'pending' | 'complete' | 'partial' | 'failed';
  reason: ClosureFailureReason | null;
}>;

export type ClosureRejection = 'forbidden' | 'stale_room' | 'operation_mismatch';

export interface ClosurePort {
  capability(roomId: RoomId, options?: CallOptions): Promise<OperationResult<ClosureCapability, 'forbidden'>>;
  closeRoom(input: ClosureRequest, options?: CallOptions): Promise<OperationResult<ClosureStatus, ClosureRejection>>;
  inspectClosure(operationId: string, options?: CallOptions): Promise<OperationResult<ClosureStatus, 'not_found' | 'forbidden'>>;
}

export function decodeClosureRequest(input: unknown): Decoded<ClosureRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'ownerId', 'roomId', 'expectedRoomRevision']);
    return {
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
      roomId: readId<'RoomId'>(r.field('roomId'), r.at('roomId')),
      expectedRoomRevision: safeInteger(r.field('expectedRoomRevision'), r.at('expectedRoomRevision')),
    };
  });
}

export function decodeClosureStatus(input: unknown): Decoded<ClosureStatus> {
  return decodeWith(() => {
    const r = object(input, '', ['operationId', 'state', 'reason']);
    const reason = r.field('reason');
    const value = {
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      state: literal(r.field('state'), r.at('state'), ['pending', 'complete', 'partial', 'failed']),
      reason: reason === null ? null : literal(reason, r.at('reason'), ['forbidden', 'stale_room', 'dependency_unavailable', 'local_cleanup_failed']),
    };
    if (value.state === 'complete' && value.reason !== null) fail(r.at('reason'), 'mismatch');
    return value;
  });
}

export function decodeClosureCapability(input: unknown): Decoded<ClosureCapability> {
  return decodeWith(() => {
    const r = object(input, '', ['ownerId', 'roomId', 'expectedRoomRevision', 'available', 'unavailableReason', 'consequences']);
    const available = r.field('available');
    const reason = r.field('unavailableReason');
    const consequences = r.field('consequences');
    const c = object(consequences, r.at('consequences'), [
      'stopsNewMessages', 'removesFromOwnerView', 'requestsLocalCleanup', 'recallsDeliveredCopies',
    ]);
    if (available !== true && available !== false) fail(r.at('available'), 'wrong_type');
    if (c.field('stopsNewMessages') !== true || c.field('removesFromOwnerView') !== true
      || c.field('requestsLocalCleanup') !== true || c.field('recallsDeliveredCopies') !== false) {
      fail(r.at('consequences'), 'mismatch');
    }
    const unavailableReason = reason === null ? null : literal(reason, r.at('unavailableReason'), ['not_configured', 'forbidden', 'stale_room', 'signed_out']);
    if (available === (unavailableReason !== null)) fail(r.at('unavailableReason'), 'mismatch');
    return {
      ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
      roomId: readId<'RoomId'>(r.field('roomId'), r.at('roomId')),
      expectedRoomRevision: safeInteger(r.field('expectedRoomRevision'), r.at('expectedRoomRevision')),
      available,
      unavailableReason,
      consequences: CLOSURE_CONSEQUENCES,
    };
  });
}
