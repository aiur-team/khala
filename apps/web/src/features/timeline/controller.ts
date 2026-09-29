// Owns the merged, generation-fenced transcript projection consumed through
// `useSyncExternalStore`. Draft text, scroll anchor and pagination-request UI
// state stay local to the screen component (KTD2) — this module only merges
// `ChannelPort.timeline` pages with `ChannelPort.observe` snapshots by opaque event
// ID and caches an immutable snapshot for the store contract.

import type { RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelMembership, ChannelPort, ChannelRejection, ChannelSnapshot, TimelineItem, TimelinePage } from '@khala/contracts/messaging/index';
import { isCurrentGeneration, type OperationResult } from '@khala/contracts/messaging/outcomes';
import type { TimelinePhase } from './model';

const DEFAULT_PAGE_SIZE = 50;

export type TimelineData = Readonly<{
  phase: TimelinePhase;
  items: readonly TimelineItem[];
  /** Complete allowed history when the background name replay reaches its boundary. */
  nameHistory?: readonly TimelineItem[];
  namesReady?: boolean;
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
  /** Reads the permitted history for stable agent-name attribution without expanding visible pages. */
  scanNameHistory?(): Promise<void>;
  /** Tells the controller whether the reader is scrolled to the newest item. */
  setReaderAtLatest(atLatest: boolean): void;
  /** Idempotent; unsubscribes the channel observer exactly once. */
  dispose(): void;
}

export function createTimelineController(
  roomPort: ChannelPort,
  roomId: RoomId,
  options: Readonly<{ generation: number; pageSize?: number }>,
): TimelineController {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const { generation } = options;

  let older: readonly TimelineItem[] = [];
  let hiddenOlder: readonly TimelineItem[] = [];
  let recent: readonly TimelineItem[] = [];
  let nextCursor: string | null = null;
  let phase: TimelinePhase = 'loading';
  let newMessageCount = 0;
  let readerAtLatest = true;
  let disposed = false;
  let membership: ChannelMembership | null = null;
  let namesReady = false;
  let hasInitialPage = false;
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
    const nameHistoryIds = new Set<string>();
    const nameHistory = [...hiddenOlder, ...older, ...recent].filter(item => {
      if (nameHistoryIds.has(item.ref.eventId)) return false;
      nameHistoryIds.add(item.ref.eventId);
      return true;
    });
    cachedData = { phase, items: mergedItems(), nameHistory, namesReady,
      nextCursor: hiddenOlder.length > 0 ? 'cached' : nextCursor, newMessageCount, membership };
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
    return older.length > 0 || recent.length > 0 ? 'partial' : 'unavailable';
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

  const disposeObserve = roomPort.observe(roomId, applySnapshot);

  // Concurrent callers (the mount-effect load racing a fast second click on
  // "Load earlier messages") share this in-flight request instead of each
  // firing their own `roomPort.timeline` call: two independent calls would
  // both compute their "new" additions against the same pre-fetch `older`
  // snapshot and each prepend a copy, duplicating rows.
  let inFlightLoadOlder: Promise<OperationResult<TimelinePage, ChannelRejection> | null> | null = null;

  function loadOlder(): Promise<OperationResult<TimelinePage, ChannelRejection> | null> {
    if (disposed) return Promise.resolve(null);
    if (inFlightLoadOlder) return inFlightLoadOlder;
    const request = (scanInFlight ? scanInFlight.then(() => performLoadOlder()) : performLoadOlder()).finally(() => {
      inFlightLoadOlder = null;
    });
    inFlightLoadOlder = request;
    return request;
  }

  async function performLoadOlder(): Promise<OperationResult<TimelinePage, ChannelRejection> | null> {
    if (hiddenOlder.length > 0) {
      const reveal = hiddenOlder.slice(-pageSize);
      hiddenOlder = hiddenOlder.slice(0, -reveal.length);
      older = [...reveal, ...older];
      itemsDirty = true;
      notify();
      return null;
    }
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
    hasInitialPage = true;
    older = [...additions, ...older];
    nextCursor = result.value.nextCursor;
    historyDegraded = null;
    phase = 'ready';
    itemsDirty = true;
    notify();
    return result;
  }

  let scanInFlight: Promise<void> | null = null;

  function scanNameHistory(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (scanInFlight) return scanInFlight;
    const run = (async () => {
      if (inFlightLoadOlder) await inFlightLoadOlder;
      if (!hasInitialPage) return;
      while (!disposed && nextCursor !== null) {
        const requestedCursor = nextCursor;
        const result = await roomPort.timeline({ roomId, cursor: nextCursor, limit: pageSize });
        if (disposed) return;
        if (result.kind !== 'ok') {
          historyDegraded = degradedPhase();
          phase = historyDegraded;
          notify();
          return;
        }
        if (result.value.nextCursor === requestedCursor) {
          historyDegraded = degradedPhase();
          phase = historyDegraded;
          notify();
          return;
        }
        const known = new Set([...hiddenOlder, ...older, ...recent].map(item => item.ref.eventId));
        hiddenOlder = [...result.value.items.filter(item => !known.has(item.ref.eventId)), ...hiddenOlder];
        nextCursor = result.value.nextCursor;
        notify();
      }
      if (!disposed) { namesReady = true; notify(); }
    })();
    scanInFlight = run.finally(() => { scanInFlight = null; });
    return scanInFlight;
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

  return { getSnapshot, subscribe, loadOlder, scanNameHistory, setReaderAtLatest, dispose };
}
