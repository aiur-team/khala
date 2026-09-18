// The narrow messaging-SDK surface the room service needs. G-SUBSTRATE is still
// open, so no SDK is imported here: the selected SDK's adapter implements this
// interface and the composition root injects it. Nothing here reaches UI callers.

import type {
  CallOptions, DeviceId, Disposer, EventId, MessageContent, ParticipantId, ParticipantView, RoomId, RoomRejection, RoomSummary,
} from '@khala/contracts/messaging/index';

/**
 * Result of an effectful substrate call. `unavailable` proves nothing was done;
 * `unknown` means the effect may have landed. Adapters never throw raw SDK
 * errors; the service still treats a thrown error as `unknown` (effects) or
 * `unavailable` (reads).
 */
export type SubstrateEffect<T> =
  | Readonly<{ kind: 'done'; value: T }>
  | Readonly<{ kind: 'rejected'; code: RoomRejection }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'unknown' }>;

export type SubstrateRead<T> =
  | Readonly<{ kind: 'done'; value: T }>
  | Readonly<{ kind: 'rejected'; code: RoomRejection }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Outcome of looking up a room created under an operation ID. `absent` must be a
 * proof that no room carries that operation ID; a substrate that cannot prove it
 * answers `unknown`, and the service keeps the create `outcome_unknown`.
 */
export type CreateLookup =
  | Readonly<{ kind: 'found'; room: RoomSummary }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Transport acceptance of one event: only the IDs the transport assigned. */
export type AcceptedEvent = Readonly<{ eventId: EventId; authorDeviceId: DeviceId }>;

/**
 * One timeline event as the SDK surfaced it. Undecryptable events keep their
 * identity so the projection can show an explicit placeholder, never a blank
 * message or an SDK exception.
 */
export type SubstrateEvent =
  | Readonly<{
    kind: 'message';
    eventId: EventId;
    authorDeviceId: DeviceId;
    participant: ParticipantView;
    content: MessageContent;
    clientTxnId: string | null;
    receivedAt: string;
  }>
  | Readonly<{
    kind: 'undecryptable';
    eventId: EventId;
    authorParticipantId: ParticipantId;
    reason: 'missing_key' | 'decryption_failed';
    receivedAt: string;
  }>;

export type SubstratePage = Readonly<{ events: readonly SubstrateEvent[]; nextCursor: string | null; revision: string }>;

/** A live room update; `generation` is the client lifecycle generation that produced it. */
export type SubstrateUpdate = Readonly<{ generation: number; room: RoomSummary | null; events: readonly SubstrateEvent[] }>;

export interface RoomSubstrate {
  /**
   * Creates an encrypted room tagged with `operationId` so `findCreatedRoom` can
   * reconcile a lost response. Room creation is not assumed idempotent.
   */
  createRoom(input: Readonly<{ operationId: string; title: string | null }>, options?: CallOptions): Promise<SubstrateEffect<RoomSummary>>;
  findCreatedRoom(input: Readonly<{ operationId: string }>, options?: CallOptions): Promise<CreateLookup>;
  room(roomId: RoomId, options?: CallOptions): Promise<SubstrateRead<RoomSummary>>;
  /**
   * Sends as the signed-in participant. The transport deduplicates on
   * `clientTxnId` for the same device, so re-sending it never creates a second
   * event.
   */
  sendEvent(
    input: Readonly<{ roomId: RoomId; clientTxnId: string; content: MessageContent }>,
    options?: CallOptions,
  ): Promise<SubstrateEffect<AcceptedEvent>>;
  /** `cursor` is passed through opaquely; `null` asks for the newest page. */
  timeline(input: Readonly<{ roomId: RoomId; cursor: string | null; limit: number }>, options?: CallOptions): Promise<SubstrateRead<SubstratePage>>;
  /** The first update carries the current state; later updates may repeat or reorder events. */
  subscribe(roomId: RoomId, listener: (update: SubstrateUpdate) => void): Disposer;
}
