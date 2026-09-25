// Channel views and the channel port consumed by human UI and connector code.

import {
  type ContentLimits, type Decoded, array, decodeWith, displayText, elementPath, fail, identifier, literal,
  nullable, object, safeInteger,
} from './decode';
import { type EventRef, type MessageContent, type TimelineItem, readEventRef, readTimelineItem, verifyContentDigest } from './events';
import { type EventId, type RoomId, readId } from './ids';
import type { CallOptions, Disposer, OperationResult } from './outcomes';

export type ChannelMembership = 'joining' | 'joined' | 'left' | 'revoked';

/** @deprecated Use `ChannelMembership`. Kept through the first tagged release containing #163. */
export type RoomMembership = ChannelMembership;

export type ChannelSummary = Readonly<{
  roomId: RoomId;
  /** An empty title is not a title: decoders map `""` to `null`. */
  title: string | null;
  membership: ChannelMembership;
  /** Opaque; scoped to this channel's projection, never compared across channels. */
  revision: string;
}>;

/** @deprecated Use `ChannelSummary`. Kept through the first tagged release containing #163. */
export type RoomSummary = ChannelSummary;

export type TimelinePage = Readonly<{
  items: readonly TimelineItem[];
  /** Opaque; `null` when no older page exists. */
  nextCursor: string | null;
  snapshotRevision: string;
}>;

/**
 * Local send state for one client transaction. `accepted` means the transport
 * accepted the event, never that any model read or processed it. An
 * `outcome_unknown` send is resolved through its `clientTxnId`: the transport
 * deduplicates on it, so re-sending the same transaction with the same content
 * either finds the landed event or sends it once.
 */
export type SendState = Readonly<{
  clientTxnId: string;
  state: 'pending' | 'accepted' | 'failed' | 'outcome_unknown';
  eventRef: EventRef | null;
}>;

/** Full replacement snapshot delivered to channel observers; never a delta. */
export type ChannelSnapshot = Readonly<{
  /** Serialized as `room` for wire compatibility. */
  room: ChannelSummary;
  items: readonly TimelineItem[];
  snapshotRevision: string;
  /** Client lifecycle generation that produced this snapshot. */
  generation: number;
}>;

/** @deprecated Use `ChannelSnapshot`. Kept through the first tagged release containing #163. */
export type RoomSnapshot = ChannelSnapshot;

export type ChannelRejection = 'forbidden' | 'not_found' | 'not_joined' | 'too_large' | 'invalid_request' | 'operation_mismatch';

/** @deprecated Use `ChannelRejection`. Kept through the first tagged release containing #163. */
export type RoomRejection = ChannelRejection;

export type IntroBatch = Readonly<{ roomId: RoomId; batchId: string; messages: readonly MessageContent[] }>;

export interface ChannelPort {
  create(input: Readonly<{ operationId: string; title: string | null }>, options?: CallOptions): Promise<OperationResult<ChannelSummary, ChannelRejection>>;
  /** One `SendState` per message, in input order. Resuming the same `batchId` never duplicates messages. */
  prepareIntro(input: IntroBatch, options?: CallOptions): Promise<OperationResult<readonly SendState[], ChannelRejection>>;
  resumeIntro(batchId: string, options?: CallOptions): Promise<OperationResult<readonly SendState[], ChannelRejection>>;
  /** `outcome_unknown` carries the `clientTxnId` as its operation ID; resolve by re-sending that transaction. */
  send(input: Readonly<{ roomId: RoomId; clientTxnId: string; content: MessageContent }>, options?: CallOptions): Promise<OperationResult<SendState, ChannelRejection>>;
  timeline(input: Readonly<{ roomId: RoomId; cursor: string | null; limit: number }>, options?: CallOptions): Promise<OperationResult<TimelinePage, ChannelRejection>>;
  observe(roomId: RoomId, listener: (snapshot: ChannelSnapshot) => void): Disposer;
}

/** @deprecated Use `ChannelPort`. Kept through the first tagged release containing #163. */
export type RoomPort = ChannelPort;

export function decodeChannelSummary(input: unknown, limits: ContentLimits): Decoded<ChannelSummary> {
  return decodeWith(() => readChannelSummary(input, '', limits));
}

export function readChannelSummary(input: unknown, path: string, limits: ContentLimits): ChannelSummary {
  const r = object(input, path, ['roomId', 'title', 'membership', 'revision']);
  const title = nullable(r.field('title'), value => displayText(value, r.at('title'), limits.maxRoomTitleBytes));
  return {
    roomId: readId<'RoomId'>(r.field('roomId'), r.at('roomId')),
    title: title === '' ? null : title,
    membership: literal(r.field('membership'), r.at('membership'), ['joining', 'joined', 'left', 'revoked']),
    revision: identifier(r.field('revision'), r.at('revision')),
  };
}

export function decodeSendState(input: unknown): Decoded<SendState> {
  return decodeWith(() => readSendState(input, ''));
}

export function readSendState(input: unknown, path: string): SendState {
  const r = object(input, path, ['clientTxnId', 'state', 'eventRef']);
  const value: SendState = {
    clientTxnId: identifier(r.field('clientTxnId'), r.at('clientTxnId')),
    state: literal(r.field('state'), r.at('state'), ['pending', 'accepted', 'failed', 'outcome_unknown']),
    eventRef: nullable(r.field('eventRef'), ref => readEventRef(ref, r.at('eventRef'))),
  };
  // Only transport acceptance yields a reference; anything else carrying one is a claim without proof.
  if ((value.state === 'accepted') !== (value.eventRef !== null)) fail(r.at('eventRef'), 'mismatch');
  return value;
}

/**
 * Event IDs are unique within the page and every item's digest is recomputed. Item
 * order is the producer's and implies no global sequence.
 */
export async function decodeTimelinePage(input: unknown, limits: ContentLimits): Promise<Decoded<TimelinePage>> {
  const decoded = decodeWith(() => {
    const r = object(input, '', ['items', 'nextCursor', 'snapshotRevision']);
    return {
      items: readItems(r.field('items'), r.at('items'), limits),
      nextCursor: nullable(r.field('nextCursor'), value => identifier(value, r.at('nextCursor'))),
      snapshotRevision: identifier(r.field('snapshotRevision'), r.at('snapshotRevision')),
    };
  });
  return decoded.ok ? await verifyItems(decoded.value.items, 'items') ?? decoded : decoded;
}

/** Items must belong to the snapshot's channel; every item's digest is recomputed. */
export async function decodeChannelSnapshot(input: unknown, limits: ContentLimits): Promise<Decoded<ChannelSnapshot>> {
  const decoded = decodeWith(() => {
    const r = object(input, '', ['room', 'items', 'snapshotRevision', 'generation']);
    const snapshot: ChannelSnapshot = {
      room: readChannelSummary(r.field('room'), r.at('room'), limits),
      items: readItems(r.field('items'), r.at('items'), limits),
      snapshotRevision: identifier(r.field('snapshotRevision'), r.at('snapshotRevision')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
    };
    snapshot.items.forEach((item, index) => {
      if (item.ref.roomId !== snapshot.room.roomId) fail(`${elementPath(r.at('items'), index)}.ref.roomId`, 'mismatch');
    });
    return snapshot;
  });
  return decoded.ok ? await verifyItems(decoded.value.items, 'items') ?? decoded : decoded;
}

/** @deprecated Use `decodeChannelSummary`. Kept through the first tagged release containing #163. */
export const decodeRoomSummary = decodeChannelSummary;
/** @deprecated Use `readChannelSummary`. Kept through the first tagged release containing #163. */
export const readRoomSummary = readChannelSummary;
/** @deprecated Use `decodeChannelSnapshot`. Kept through the first tagged release containing #163. */
export const decodeRoomSnapshot = decodeChannelSnapshot;

async function verifyItems(items: readonly TimelineItem[], path: string): Promise<Decoded<never> | null> {
  for (const [index, item] of items.entries()) {
    const mismatch = await verifyContentDigest(item, `${elementPath(path, index)}.ref.contentDigest`);
    if (mismatch) return mismatch;
  }
  return null;
}

function readItems(input: unknown, path: string, limits: ContentLimits): readonly TimelineItem[] {
  const seen = new Set<EventId>();
  return array(input, path).map((value, index) => {
    const item = readTimelineItem(value, elementPath(path, index), limits);
    if (seen.has(item.ref.eventId)) fail(`${elementPath(path, index)}.ref.eventId`, 'duplicate');
    seen.add(item.ref.eventId);
    return item;
  });
}
