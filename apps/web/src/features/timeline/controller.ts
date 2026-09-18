// Owns the merged, generation-fenced transcript projection consumed through
// `useSyncExternalStore`. Draft text, scroll anchor and pagination-request UI
// state stay local to the screen component (KTD2) — this module only merges
// `RoomPort.timeline` pages with `RoomPort.observe` snapshots by opaque event
// ID and caches an immutable snapshot for the store contract.

import type { RoomId } from '@khala/contracts/messaging/ids';
import type { RoomPort, RoomRejection, RoomSnapshot, TimelineItem, TimelinePage } from '@khala/contracts/messaging/index';
import { isCurrentGeneration, type OperationResult } from '@khala/contracts/messaging/outcomes';
import type { TimelinePhase } from './model';

const DEFAULT_PAGE_SIZE = 50;

export type TimelineData = Readonly<{
  phase: TimelinePhase;
  items: readonly TimelineItem[];
  nextCursor: string | null;
  newMessageCount: number;
}>;

export interface TimelineController {
  /** Cached, `useSyncExternalStore`-safe: returns the same reference until state changes. */
  getSnapshot(): TimelineData;
  subscribe(listener: () => void): () => void;
  /** Prepends one older page. A no-op once `dispose()` has run. */
  loadOlder(): Promise<OperationResult<TimelinePage, RoomRejection> | null>;
  /** Tells the controller whether the reader is scrolled to the newest item. */
  setReaderAtLatest(atLatest: boolean): void;
  /** Idempotent; unsubscribes the room observer exactly once. */
  dispose(): void;
}

export function createTimelineController(
  roomPort: RoomPort,
  roomId: RoomId,
  options: Readonly<{ generation: number; pageSize?: number }>,
): TimelineController {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const { generation } = options;

  let older: readonly TimelineItem[] = [];
  let recent: readonly TimelineItem[] = [];
  let nextCursor: string | null = null;
  let phase: TimelinePhase = 'loading';
  let newMessageCount = 0;
  let readerAtLatest = true;
  let disposed = false;

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
    cachedData = { phase, items: mergedItems(), nextCursor, newMessageCount };
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

  function applySnapshot(snapshot: RoomSnapshot): void {
    if (disposed || !isCurrentGeneration(generation, snapshot)) return;
    const previouslyKnown = new Set([...older, ...recent].map(item => item.ref.eventId));
    const arrivedCount = snapshot.items.filter(item => !previouslyKnown.has(item.ref.eventId)).length;
    recent = snapshot.items;
    itemsDirty = true;
    phase = 'ready';
    if (!readerAtLatest) newMessageCount += arrivedCount;
    notify();
  }

  const disposeObserve = roomPort.observe(roomId, applySnapshot);

  // Concurrent callers (the mount-effect load racing a fast second click on
  // "Load earlier messages") share this in-flight request instead of each
  // firing their own `roomPort.timeline` call: two independent calls would
  // both compute their "new" additions against the same pre-fetch `older`
  // snapshot and each prepend a copy, duplicating rows.
  let inFlightLoadOlder: Promise<OperationResult<TimelinePage, RoomRejection> | null> | null = null;

  function loadOlder(): Promise<OperationResult<TimelinePage, RoomRejection> | null> {
    if (disposed) return Promise.resolve(null);
    if (inFlightLoadOlder) return inFlightLoadOlder;
    const request = performLoadOlder().finally(() => {
      inFlightLoadOlder = null;
    });
    inFlightLoadOlder = request;
    return request;
  }

  async function performLoadOlder(): Promise<OperationResult<TimelinePage, RoomRejection> | null> {
    const result = await roomPort.timeline({ roomId, cursor: nextCursor, limit: pageSize });
    if (disposed) return null;
    if (result.kind !== 'ok') {
      if (phase === 'loading' && older.length === 0 && recent.length === 0) phase = 'unavailable';
      notify();
      return result;
    }
    const knownIds = new Set([...older, ...recent].map(item => item.ref.eventId));
    const additions = result.value.items.filter(item => !knownIds.has(item.ref.eventId));
    older = [...additions, ...older];
    nextCursor = result.value.nextCursor;
    if (phase === 'loading') phase = 'ready';
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
