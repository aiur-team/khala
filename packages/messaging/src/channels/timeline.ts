// Projects SDK events and local sends into channel timeline views. Each
// event appears once however the remote echo and the send response interleave.

import {
  type CallOptions, type EventId, type MessageContent, type OperationResult, type ParticipantId, type RoomId,
  type ChannelRejection, type ChannelSnapshot, type ChannelSummary, type SendState, type TimelineItem, type TimelinePage,
  digestMessageContent, ok, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { type ChannelContext, isIdentifier, safeRead } from './context';
import type { SendItem } from './journal';
import type { SubstrateEvent } from './substrate';

/**
 * A timeline row. `unavailable` is an event this device cannot decrypt: shown as
 * an explicit placeholder, never as a blank message. `local` is an own send the
 * channel has not yet echoed.
 */
export type TimelineEntry =
  | Readonly<{ kind: 'message'; item: TimelineItem }>
  | Readonly<{
    kind: 'unavailable';
    eventId: EventId;
    authorParticipantId: ParticipantId;
    reason: 'missing_key' | 'decryption_failed' | 'digest_unavailable';
    receivedAt: string;
  }>
  | Readonly<{ kind: 'local'; send: SendState; content: MessageContent }>;

/** Full replacement view of one channel, including placeholders and local sends. */
export type ChannelEntriesView = Readonly<{
  roomId: RoomId;
  room: ChannelSummary | null;
  entries: readonly TimelineEntry[];
  snapshotRevision: string;
  generation: number;
}>;

/** @deprecated Use `ChannelEntriesView`. Kept through the first tagged release containing #163. */
export type RoomEntriesView = ChannelEntriesView;

type RemoteEntry = Exclude<TimelineEntry, { kind: 'local' }>;

/** Binds decrypted content to a reference whose digest is computed here, over the exact bytes. */
export async function toEntry(roomId: RoomId, event: SubstrateEvent): Promise<RemoteEntry> {
  if (event.kind === 'undecryptable') {
    return { kind: 'unavailable', eventId: event.eventId, authorParticipantId: event.authorParticipantId, reason: event.reason, receivedAt: event.receivedAt };
  }
  const digest = await digestMessageContent(event.content);
  if (!digest.ok) {
    return {
      kind: 'unavailable', eventId: event.eventId, authorParticipantId: event.participant.participantId,
      reason: digest.reason === 'crypto_unavailable' ? 'digest_unavailable' : 'decryption_failed', receivedAt: event.receivedAt,
    };
  }
  return {
    kind: 'message',
    item: {
      ref: {
        v: 1, roomId, eventId: event.eventId, authorParticipantId: event.participant.participantId,
        authorDeviceId: event.authorDeviceId, contentDigest: digest.digest,
      },
      content: event.content,
      participant: event.participant,
      clientTxnId: event.clientTxnId,
      receivedAt: event.receivedAt,
    },
  };
}

function eventIdOf(entry: RemoteEntry): EventId {
  return entry.kind === 'message' ? entry.item.ref.eventId : entry.eventId;
}

export async function timeline(
  ctx: ChannelContext, input: Readonly<{ roomId: RoomId; cursor: string | null; limit: number }>, options?: CallOptions,
): Promise<OperationResult<TimelinePage, ChannelRejection>> {
  if (!isIdentifier(input.roomId) || (input.cursor !== null && !isIdentifier(input.cursor))
    || !Number.isSafeInteger(input.limit) || input.limit < 1) {
    return rejected('invalid_request');
  }
  if (ctx.stopped()) return unavailable();
  const page = await safeRead(() => ctx.substrate.timeline(input, options));
  if (page.kind === 'unavailable') return unavailable();
  if (page.kind === 'rejected') return rejected(page.code);
  const entries = new Map<EventId, RemoteEntry>();
  for (const event of page.value.events) {
    const entry = await toEntry(input.roomId, event);
    if (supersedes(entries.get(eventIdOf(entry)), entry)) entries.set(eventIdOf(entry), entry);
  }
  // The contract page has no placeholder shape; `observeEntries` carries them.
  const items = [...entries.values()].flatMap(entry => (entry.kind === 'message' ? [entry.item] : []));
  return ok({ items, nextCursor: page.value.nextCursor, snapshotRevision: page.value.revision });
}

/** A duplicate or replayed event never adds a row; only a late decryption replaces its placeholder. */
function supersedes(existing: RemoteEntry | undefined, entry: RemoteEntry): boolean {
  return existing === undefined || (existing.kind === 'unavailable' && entry.kind === 'message');
}

/**
 * Live state of one channel. Remote events are keyed by event ID; own sends are keyed
 * by transaction ID until the channel or the send response names their event.
 */
export class ChannelProjection {
  private readonly remote = new Map<EventId, RemoteEntry>();
  private readonly local = new Map<string, Readonly<{ send: SendState; content: MessageContent }>>();
  private room: ChannelSummary | null = null;
  private revision = 0;

  constructor(
    private readonly roomId: RoomId,
    private readonly self: TimelineItem['participant'],
    private readonly now: () => string,
  ) {}

  applyRoom(room: ChannelSummary | null): void {
    if (room === null || room.roomId !== this.roomId) return;
    this.room = room;
    this.revision += 1;
  }

  applyRemote(entries: readonly RemoteEntry[]): void {
    for (const entry of entries) {
      const eventId = eventIdOf(entry);
      if (!supersedes(this.remote.get(eventId), entry)) continue;
      this.remote.set(eventId, entry);
      if (entry.kind === 'message' && entry.item.clientTxnId !== null) this.local.delete(entry.item.clientTxnId);
    }
    this.revision += 1;
  }

  applyLocal(item: SendItem): void {
    if (item.eventRef) {
      this.local.delete(item.clientTxnId);
      if (!this.remote.has(item.eventRef.eventId)) {
        this.remote.set(item.eventRef.eventId, {
          kind: 'message',
          item: { ref: item.eventRef, content: item.content, participant: this.self, clientTxnId: item.clientTxnId, receivedAt: this.now() },
        });
      }
    } else if (![...this.remote.values()].some(entry => entry.kind === 'message' && entry.item.clientTxnId === item.clientTxnId)) {
      this.local.set(item.clientTxnId, { send: { clientTxnId: item.clientTxnId, state: item.state, eventRef: null }, content: item.content });
    }
    this.revision += 1;
  }

  entries(generation: number): ChannelEntriesView {
    const entries: TimelineEntry[] = [...this.remote.values()];
    for (const pending of this.local.values()) entries.push({ kind: 'local', ...pending });
    return { roomId: this.roomId, room: this.room, entries, snapshotRevision: String(this.revision), generation };
  }

  /** The contract snapshot: known channel and decrypted messages only. */
  snapshot(generation: number): ChannelSnapshot | null {
    if (this.room === null) return null;
    const items: TimelineItem[] = [];
    for (const entry of this.remote.values()) if (entry.kind === 'message') items.push(entry.item);
    return { room: this.room, items, snapshotRevision: String(this.revision), generation };
  }
}

/** @deprecated Use `ChannelProjection`. Kept through the first tagged release containing #163. */
export const RoomProjection = ChannelProjection;
/** @deprecated Use `ChannelProjection`. Kept through the first tagged release containing #163. */
export type RoomProjection = ChannelProjection;
