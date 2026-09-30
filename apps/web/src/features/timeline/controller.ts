// Owns the merged, generation-fenced transcript projection consumed through
// `useSyncExternalStore`. Draft text, scroll anchor and pagination-request UI
// state stay local to the screen component (KTD2) — this module only merges
// `ChannelPort.timeline` pages with live message/entry snapshots by opaque event
// ID and caches an immutable snapshot for the store contract.

import type { EventId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelMembership, ChannelSummary, ChannelPort, ChannelRejection, ChannelSnapshot, TimelineItem, TimelinePage } from '@khala/contracts/messaging/index';
import { isCurrentGeneration, type OperationResult } from '@khala/contracts/messaging/outcomes';
import type { TimelinePhase } from './model';

const DEFAULT_PAGE_SIZE = 50;

/** Presentation-only projection; unavailable events have no authenticated participant or content. */
export type TimelineRow = Readonly<{ kind: 'message'; item: TimelineItem }>
  | Readonly<{ kind: 'unavailable'; eventId: EventId; receivedAt: string }>;
export type TimelineEntriesView = Readonly<{
  roomId: RoomId;
  room: ChannelSummary | null;
  generation: number;
  historicalEventIds?: readonly EventId[];
  entries: readonly (TimelineRow | Readonly<{ kind: 'local' }>)[];
}>;
const rowId = (row: TimelineRow) => row.kind === 'message' ? row.item.ref.eventId : row.eventId;

export type TimelineData = Readonly<{
  phase: TimelinePhase;
  items: readonly TimelineItem[];
  rows?: readonly TimelineRow[];
  nextCursor: string | null;
  newMessageCount: number;
  /** `null` until the first channel snapshot arrives. `revoked`/`left` means the viewer can no longer read or send live. */
  membership: ChannelMembership | null;
}>;

export interface TimelineController {
  /** Cached, `useSyncExternalStore`-safe: returns the same reference until state changes. */
  getSnapshot(): TimelineData;
  subscribe(listener: () => void): () => void;
  /** Prepends one older page. A no-op once `dispose()` has run. */
  loadOlder(): Promise<OperationResult<TimelinePage, ChannelRejection> | null>;
  /** Tells the controller whether the reader is scrolled to the newest item. */
  setReaderAtLatest(atLatest: boolean): void;
  /** Idempotent; unsubscribes the channel observer exactly once. */
  dispose(): void;
}

export function createTimelineController(
  roomPort: ChannelPort & Partial<{ observeEntries(roomId: RoomId, listener: (view: TimelineEntriesView) => void): () => void }>,
  roomId: RoomId,
  options: Readonly<{ generation: number; pageSize?: number }>,
): TimelineController {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const { generation } = options;

  let older: readonly TimelineItem[] = [];
  let recent: readonly TimelineItem[] = [];
  let recentRows: readonly TimelineRow[] | null = null;
  let nextCursor: string | null = null;
  let phase: TimelinePhase = 'loading';
  let newMessageCount = 0;
  let readerAtLatest = true;
  let readingHistory = false;
  let disposed = false;
  let membership: ChannelMembership | null = null;
  // Set on a failed history read, cleared only by a *successful* one — a live
  // snapshot arriving in between must not paper over a known history gap by
  // reporting `ready` (order-independent: forbidden-then-snapshot and
  // snapshot-then-forbidden both end up here, not just one of them).
  let historyDegraded: 'unavailable' | 'partial' | null = null;

  let cachedItems: readonly TimelineItem[] | null = null;
  let itemsDirty = true;
  let cachedData: TimelineData | null = null;
  let dataDirty = true;

  const listeners = new Set<() => void>();

  function mergedItems(): readonly TimelineItem[] {
    if (!itemsDirty && cachedItems) return cachedItems;
    const recentIds = new Set(recent.map(item => item.ref.eventId));
    cachedItems = [...older.filter(item => !recentIds.has(item.ref.eventId)), ...recent];
    itemsDirty = false;
    return cachedItems;
  }

  function getSnapshot(): TimelineData {
    if (!dataDirty && cachedData) return cachedData;
    const items = mergedItems();
    const liveRows = recentRows;
    const liveIds = new Set(liveRows?.map(rowId));
    const olderById = new Map(older.map(item => [item.ref.eventId, item]));
    const rows = liveRows === null ? items.map(item => ({ kind: 'message' as const, item }))
      : [...older.filter(item => !liveIds.has(item.ref.eventId)).map(item => ({ kind: 'message' as const, item })), ...liveRows.map(row => {
        const decoded = row.kind === 'unavailable' ? olderById.get(row.eventId) : undefined;
        return decoded ? { kind: 'message' as const, item: decoded } : row;
      })];
    cachedData = { phase, items, rows, nextCursor, newMessageCount, membership };
    dataDirty = false;
    return cachedData;
  }

  function notify(): void {
    dataDirty = true;
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function degradedPhase(): 'unavailable' | 'partial' {
    return older.length > 0 || recent.length > 0 || (recentRows?.length ?? 0) > 0 ? 'partial' : 'unavailable';
  }

  function applySnapshot(snapshot: ChannelSnapshot): void {
    if (disposed || !isCurrentGeneration(generation, snapshot)) return;
    const previouslyKnown = new Set([...older, ...recent].map(item => item.ref.eventId));
    const arrivedCount = snapshot.items.filter(item => !previouslyKnown.has(item.ref.eventId)).length;
    recent = snapshot.items;
    itemsDirty = true;
    membership = snapshot.room.membership;
    // A known history gap outlives a fresher live snapshot: recompute the
    // degraded phase against the now-larger item set instead of clearing it,
    // since only a successful history read (`performLoadOlder`) may clear it.
    phase = historyDegraded ? degradedPhase() : 'ready';
    if (!readerAtLatest) newMessageCount += arrivedCount;
    notify();
  }

  const disposeObserve = roomPort.observeEntries ? roomPort.observeEntries(roomId, view => {
    if (disposed || view.roomId !== roomId || !isCurrentGeneration(generation, view)) return;
    const previousRows = getSnapshot().rows ?? [];
    const previouslyKnown = new Set(previousRows.map(rowId));
    const historicalIds = new Set(view.historicalEventIds);
    const rows = new Map<string, TimelineRow>();
    for (const entry of view.entries) {
      if (entry.kind === 'local') continue;
      const existing = rows.get(rowId(entry));
      if (!existing || entry.kind === 'message') rows.set(rowId(entry), entry);
    }
    recentRows = [...rows.values()];
    recent = recentRows.flatMap(row => row.kind === 'message' ? [row.item] : []);
    itemsDirty = true;
    membership = view.room?.membership ?? membership;
    phase = historyDegraded ? degradedPhase() : view.room ? 'ready' : 'loading';
    // History can publish after its request resolves; source IDs distinguish it
    // from live events even when server timestamps tie or move backwards.
    if (!readerAtLatest && !readingHistory) {
      newMessageCount += recentRows.filter(row => !previouslyKnown.has(rowId(row))
        && !historicalIds.has(rowId(row))).length;
    }
    notify();
  }) : roomPort.observe(roomId, applySnapshot);

  // Concurrent callers (the mount-effect load racing a fast second click on
  // "Load earlier messages") share this in-flight request instead of each
  // firing their own `roomPort.timeline` call: two independent calls would
  // both compute their "new" additions against the same pre-fetch `older`
  // snapshot and each prepend a copy, duplicating rows.
  let inFlightLoadOlder: Promise<OperationResult<TimelinePage, ChannelRejection> | null> | null = null;

  function loadOlder(): Promise<OperationResult<TimelinePage, ChannelRejection> | null> {
    if (disposed) return Promise.resolve(null);
    if (inFlightLoadOlder) return inFlightLoadOlder;
    readingHistory = true;
    const request = performLoadOlder().finally(() => {
      readingHistory = false;
      inFlightLoadOlder = null;
    });
    inFlightLoadOlder = request;
    return request;
  }

  async function performLoadOlder(): Promise<OperationResult<TimelinePage, ChannelRejection> | null> {
    const result = await roomPort.timeline({ roomId, cursor: nextCursor, limit: pageSize });
    if (disposed) return null;
    if (result.kind !== 'ok') {
      // Any history failure is reported, never silently swallowed as a full,
      // empty room: with no items at all it's `unavailable`; with some items
      // already known (from a live snapshot or an earlier page) it's
      // `partial`, since the transcript is known-incomplete rather than done.
      // This sticks until a history read succeeds, even across live snapshots.
      historyDegraded = degradedPhase();
      phase = historyDegraded;
      notify();
      return result;
    }
    const knownIds = new Set([...older, ...recent].map(item => item.ref.eventId));
    const additions = result.value.items.filter(item => !knownIds.has(item.ref.eventId));
    older = [...additions, ...older];
    nextCursor = result.value.nextCursor;
    historyDegraded = null;
    phase = 'ready';
    itemsDirty = true;
    notify();
    return result;
  }

  function setReaderAtLatest(atLatest: boolean): void {
    readerAtLatest = atLatest;
    if (atLatest && newMessageCount !== 0) {
      newMessageCount = 0;
      notify();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    disposeObserve();
  }

  return { getSnapshot, subscribe, loadOlder, setReaderAtLatest, dispose };
}
