import { decodeLocalChannelsPage, decodeLocalEventsPage, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type LocalChannelSummary } from '@khala/contracts/m1/local';
import type { Disposer, RoomId } from '@khala/contracts/messaging/index';
import type { ConversationSummary } from '../../ui/conversation';
import { sortConversations, type ConversationIndexPort } from '../human/conversations';
import type { SyncStatusPort } from '../human/sync-status';
import { LOCAL_CHANNELS_PATH, localRoomPath, type LocalHttp } from './http';

export const LAST_SEEN_KEY_PREFIX = 'khala.local.last-seen.v1:';
export type LocalConversations = ConversationIndexPort & Readonly<{
  viewing(roomId: RoomId): Disposer;
  /** When a member took its current name in a channel (its latest membership event), from the live channel list. */
  memberSince(roomId: RoomId, userId: string): number | null;
  syncStatus: SyncStatusPort;
  dispose(): void;
}>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
function safeLocalStorage(): StoragePort | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createLocalConversations(http: LocalHttp, options?: Readonly<{
  storage?: StoragePort | null;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}>): LocalConversations {
  const storage = options?.storage === undefined ? safeLocalStorage() : options.storage;
  const pause = options?.sleep ?? sleep;
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const viewers = new Map<string, number>();
  // Retain read markers in memory too when storage is absent or throws.
  const seen = new Map<string, number>();
  const unread = new Map<string, number>();
  const reads = new Map<string, { lastSeq: number; lastSeen: number }>();
  let items: readonly ConversationSummary[] | null | undefined;
  let lastSummaries: readonly LocalChannelSummary[] = [];
  let revision: number | null = null;
  let live = false;
  let started = false;

  function notify() {
    for (const listener of listeners) {
      try { listener(); } catch { /* Isolate subscriber failures. */ }
    }
  }
  function lastSeen(roomId: string): number {
    if (seen.has(roomId)) return seen.get(roomId)!;
    try {
      const value = Number(storage?.getItem(LAST_SEEN_KEY_PREFIX + roomId));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch { return 0; }
  }
  function markSeen(s: LocalChannelSummary) {
    seen.set(s.roomId, s.lastSeq);
    try { storage?.setItem(LAST_SEEN_KEY_PREFIX + s.roomId, String(s.lastSeq)); } catch { /* Memory marker still works. */ }
  }
  function needsUnread(s: LocalChannelSummary): boolean {
    return !viewers.has(s.roomId) && s.lastSeq > lastSeen(s.roomId)
      && !!s.lastSender && s.lastSender.userId !== LOCAL_OWNER_USER_ID;
  }
  async function countUnread(s: LocalChannelSummary) {
    const marker = { lastSeq: s.lastSeq, lastSeen: lastSeen(s.roomId) };
    reads.set(s.roomId, marker);
    try {
      const result = await http.get(localRoomPath(s.roomId, `/events?after=${marker.lastSeen}&wait=0`), decodeLocalEventsPage, abort.signal);
      // A newer summary or an intervening view invalidates this answer.
      if (abort.signal.aborted || result.kind !== 'ok' || reads.get(s.roomId) !== marker
        || lastSeen(s.roomId) !== marker.lastSeen || !needsUnread(s)
        || lastSummaries.find(current => current.roomId === s.roomId)?.lastSeq !== marker.lastSeq) return;
      const count = result.value.events.filter(e => e.type === 'm.room.message' && e.sender !== LOCAL_OWNER_USER_ID).length;
      unread.set(s.roomId, count);
      rebuild();
    } catch { /* Read this (room, lastSeq) only once, including failed reads. */ }
  }
  function rebuild(): boolean {
    if (abort.signal.aborted || !Array.isArray(items)) return false;
    for (const s of lastSummaries) if (viewers.has(s.roomId)) { markSeen(s); unread.delete(s.roomId); reads.delete(s.roomId); }
    const mapped = sortConversations(lastSummaries.map(s => ({
      id: s.roomId, title: s.name, preview: s.preview,
      timestamp: s.preview === null ? null : new Date(s.lastTs).toISOString(),
      unreadCount: needsUnread(s) ? unread.get(s.roomId) || null : null,
      members: s.members.filter(m => m.userId !== LOCAL_OWNER_USER_ID).map(m => ({
        id: m.userId, kind: m.kind, displayName: m.displayName, ownerId: LOCAL_OWNER_ID,
        ...(m.harness ? { harness: m.harness } : {}),
      })),
      ...(s.preview !== null && s.lastSender ? { lastSender: {
        label: s.lastSender.displayName, isViewer: s.lastSender.userId === LOCAL_OWNER_USER_ID,
      } } : {}),
    })));
    const changed = JSON.stringify(mapped) !== JSON.stringify(items);
    if (changed) { items = mapped; notify(); }
    for (const s of lastSummaries) {
      if (needsUnread(s) && reads.get(s.roomId)?.lastSeq !== s.lastSeq) void countUnread(s);
    }
    return changed;
  }
  async function loop() {
    let backoff = 1000;
    while (!abort.signal.aborted) {
      try {
        const result = await http.get(`${LOCAL_CHANNELS_PATH}?${revision === null ? '' : `since=${revision}&`}wait=25`,
          decodeLocalChannelsPage, abort.signal, 35_000);
        if (abort.signal.aborted) return;
        if (result.kind === 'ok') {
          const wasLive = live;
          const loading = !Array.isArray(items);
          revision = result.value.revision;
          lastSummaries = result.value.channels;
          live = true;
          if (loading) items = [];
          const changed = rebuild();
          if ((loading || !wasLive) && !changed) notify();
          backoff = 1000;
          continue;
        }
      } catch { if (abort.signal.aborted) return; }
      const changed = live || items === undefined;
      live = false;
      if (items === undefined) items = null;
      if (changed) notify();
      try { await pause(backoff, abort.signal); } catch { /* Disposal may reject an injected sleep. */ }
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
  function start() {
    if (!started && !abort.signal.aborted) { started = true; void loop(); }
  }
  function subscribe(ownerId: string, _generation: number, listener: () => void): Disposer {
    void _generation;
    if (ownerId !== LOCAL_OWNER_ID || abort.signal.aborted) return () => undefined;
    listeners.add(listener); start();
    return () => { listeners.delete(listener); };
  }
  return {
    snapshot(ownerId) { if (ownerId !== LOCAL_OWNER_ID) return null; start(); return items; },
    subscribe,
    syncStatus: { live: ownerId => ownerId === LOCAL_OWNER_ID && live, subscribe },
    viewing(roomId) {
      if (abort.signal.aborted) return () => undefined;
      viewers.set(roomId, (viewers.get(roomId) ?? 0) + 1);
      rebuild();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (viewers.get(roomId) ?? 1) - 1;
        if (remaining) viewers.set(roomId, remaining); else viewers.delete(roomId);
        rebuild();
      };
    },
    memberSince: (roomId, userId) => lastSummaries.find(item => item.roomId === roomId)?.members.find(member => member.userId === userId)?.since ?? null,
    dispose() { abort.abort(); live = false; listeners.clear(); },
  };
}
