// P13 channel closure is an owner-authorized lifecycle operation. It ends this
// owner's participation; it does not erase transport or recipient copies.

import { array, elementPath, type Decoded, decodeWith, fail, identifier, literal, object, safeInteger } from './decode';
import { type BindingId, type OwnerId, type RoomId, readId } from './ids';
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
  /** Owner/channel participation generation. The current one-way lifecycle is generation 0. */
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

export type ClosureBindingFence = Readonly<{ bindingId: BindingId; generation: number }>;

/** Protected server aggregate for the exact close operation. A single binding
 * cannot prove closure: the marker blocks future admission and every active
 * binding at its revision has acknowledged its poll/intake/dispatch fence.
 * The protected server, not a connector-supplied count, must enumerate them. */
export type ClosureConnectorReceipt = ClosureRequest & Readonly<{
  markerRevision: number;
  activeBindingCount: number;
  fencedBindings: readonly ClosureBindingFence[];
  state: 'stopped';
  futureBindingAdmissionBlocked: true;
  relayPollBlocked: true;
  relayIntakeBlocked: true;
  modelDispatchBlocked: true;
  cleanupRequested: true;
}>;

export type ClosureConnectorStopResult =
  | Readonly<{ kind: 'stopped'; receipt: ClosureConnectorReceipt }>
  | Readonly<{ kind: 'pending' | 'unavailable' }>;

export type ClosureStatus = Readonly<{
  operationId: string;
  /** Partial may mean delivery stop or leave is unconfirmed, or only local cleanup remains. Inspect `reason`. */
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

export function decodeClosureConnectorReceipt(input: unknown): Decoded<ClosureConnectorReceipt> {
  return decodeWith(() => {
    const r = object(input, '', [
      'operationId', 'ownerId', 'roomId', 'expectedRoomRevision',
      'markerRevision', 'activeBindingCount', 'fencedBindings', 'state',
      'futureBindingAdmissionBlocked', 'relayPollBlocked', 'relayIntakeBlocked', 'modelDispatchBlocked', 'cleanupRequested',
    ]);
    for (const key of ['futureBindingAdmissionBlocked', 'relayPollBlocked', 'relayIntakeBlocked', 'modelDispatchBlocked', 'cleanupRequested']) {
      if (r.field(key) !== true) fail(r.at(key), 'mismatch');
    }
    const markerRevision = safeInteger(r.field('markerRevision'), r.at('markerRevision'));
    if (markerRevision === 0) fail(r.at('markerRevision'), 'invalid_value');
    const activeBindingCount = safeInteger(r.field('activeBindingCount'), r.at('activeBindingCount'));
    const seen = new Set<string>();
    const fencedBindings = array(r.field('fencedBindings'), r.at('fencedBindings')).map((value, index) => {
      const path = elementPath(r.at('fencedBindings'), index);
      const fence = object(value, path, ['bindingId', 'generation']);
      const bindingId = readId<'BindingId'>(fence.field('bindingId'), fence.at('bindingId'));
      const generation = safeInteger(fence.field('generation'), fence.at('generation'));
      const identity = JSON.stringify([bindingId, generation]);
      if (seen.has(identity)) fail(path, 'duplicate');
      seen.add(identity);
      return { bindingId, generation };
    });
    if (fencedBindings.length !== activeBindingCount) fail(r.at('activeBindingCount'), 'mismatch');
    return {
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
      roomId: readId<'RoomId'>(r.field('roomId'), r.at('roomId')),
      expectedRoomRevision: safeInteger(r.field('expectedRoomRevision'), r.at('expectedRoomRevision')),
      markerRevision, activeBindingCount, fencedBindings,
      state: literal(r.field('state'), r.at('state'), ['stopped']),
      futureBindingAdmissionBlocked: true,
      relayPollBlocked: true,
      relayIntakeBlocked: true,
      modelDispatchBlocked: true,
      cleanupRequested: true,
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
