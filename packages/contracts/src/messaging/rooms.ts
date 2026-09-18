// Room views and the room port consumed by human UI and connector code.

import {
  type ContentLimits, type Decoded, array, decodeWith, elementPath, fail, identifier, label, literal,
  nullable, object, safeInteger,
} from './decode';
import { type EventRef, type MessageContent, type TimelineItem, readEventRef, readTimelineItem, verifyContentDigest } from './events';
import type { CallOptions, Disposer, OperationResult } from './outcomes';

export type RoomMembership = 'joining' | 'joined' | 'left' | 'revoked';

export type RoomSummary = Readonly<{
  roomId: string;
  /** An empty title is not a title: decoders map `""` to `null`. */
  title: string | null;
  membership: RoomMembership;
  /** Opaque; scoped to this room's projection, never compared across rooms. */
  revision: string;
}>;

export type TimelinePage = Readonly<{
  items: readonly TimelineItem[];
  /** Opaque; `null` when no older page exists. */
  nextCursor: string | null;
  snapshotRevision: string;
}>;

/**
 * Local send state for one client transaction. `accepted` means the transport
 * accepted the event, never that any model read or processed it.
 */
export type SendState = Readonly<{
  clientTxnId: string;
  state: 'pending' | 'accepted' | 'failed' | 'outcome_unknown';
  eventRef: EventRef | null;
}>;

/** Full replacement snapshot delivered to room observers; never a delta. */
export type RoomSnapshot = Readonly<{
  room: RoomSummary;
  items: readonly TimelineItem[];
  snapshotRevision: string;
  /** Client lifecycle generation that produced this snapshot. */
  generation: number;
}>;

export type RoomRejection = 'forbidden' | 'not_found' | 'not_joined' | 'too_large' | 'invalid_request' | 'operation_mismatch';

export type IntroBatch = Readonly<{ roomId: string; batchId: string; messages: readonly MessageContent[] }>;

export interface RoomPort {
  create(input: Readonly<{ operationId: string; title: string | null }>, options?: CallOptions): Promise<OperationResult<RoomSummary, RoomRejection>>;
  /** One `SendState` per message, in input order. Resuming the same `batchId` never duplicates messages. */
  prepareIntro(input: IntroBatch, options?: CallOptions): Promise<OperationResult<readonly SendState[], RoomRejection>>;
  resumeIntro(batchId: string, options?: CallOptions): Promise<OperationResult<readonly SendState[], RoomRejection>>;
  send(input: Readonly<{ roomId: string; clientTxnId: string; content: MessageContent }>, options?: CallOptions): Promise<OperationResult<SendState, RoomRejection>>;
  timeline(input: Readonly<{ roomId: string; cursor: string | null; limit: number }>, options?: CallOptions): Promise<OperationResult<TimelinePage, RoomRejection>>;
  observe(roomId: string, listener: (snapshot: RoomSnapshot) => void): Disposer;
}

export function decodeRoomSummary(input: unknown, limits: ContentLimits): Decoded<RoomSummary> {
  return decodeWith(() => readRoomSummary(input, '', limits));
}

export function readRoomSummary(input: unknown, path: string, limits: ContentLimits): RoomSummary {
  const r = object(input, path, ['roomId', 'title', 'membership', 'revision']);
  const title = nullable(r.field('title'), value => label(value, r.at('title'), limits.maxRoomTitleBytes));
  return {
    roomId: identifier(r.field('roomId'), r.at('roomId')),
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

/** Items must belong to the snapshot's room; every item's digest is recomputed. */
export async function decodeRoomSnapshot(input: unknown, limits: ContentLimits): Promise<Decoded<RoomSnapshot>> {
  const decoded = decodeWith(() => {
    const r = object(input, '', ['room', 'items', 'snapshotRevision', 'generation']);
    const snapshot: RoomSnapshot = {
      room: readRoomSummary(r.field('room'), r.at('room'), limits),
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

async function verifyItems(items: readonly TimelineItem[], path: string): Promise<Decoded<never> | null> {
  for (const [index, item] of items.entries()) {
    const mismatch = await verifyContentDigest(item, `${elementPath(path, index)}.ref.contentDigest`);
    if (mismatch) return mismatch;
  }
  return null;
}

function readItems(input: unknown, path: string, limits: ContentLimits): readonly TimelineItem[] {
  const seen = new Set<string>();
  return array(input, path).map((value, index) => {
    const item = readTimelineItem(value, elementPath(path, index), limits);
    if (seen.has(item.ref.eventId)) fail(`${elementPath(path, index)}.ref.eventId`, 'duplicate');
    seen.add(item.ref.eventId);
    return item;
  });
}
