// Keeps the composer's unreconciled sends across a reload. Only operation
// identity and the exact bytes are stored; the durable channel journal holds
// the authoritative intent, and a retry resolves it under the same `clientTxnId`.

import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { PendingSendStore } from '../../features/timeline/TimelineScreen';
import type { PendingSend } from '../../features/timeline/send';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PHASES = new Set(['pending', 'accepted', 'failed', 'outcome_unknown']);
const MAX_ENTRIES = 50;

function valid(value: unknown): value is PendingSend {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const content = entry.content as Record<string, unknown> | null;
  return Object.keys(entry).length === 3 && typeof entry.clientTxnId === 'string' && entry.clientTxnId.length > 0
    && PHASES.has(entry.phase as string)
    && typeof content === 'object' && content !== null && content.v === 1 && content.kind === 'text' && typeof content.body === 'string';
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createPendingSendStore(ownerId: OwnerId, roomId: RoomId, storage: Storage | null = defaultStorage()): PendingSendStore {
  const key = `khala.internal.pending.v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(roomId)}`;
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(storage?.getItem(key) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX_ENTRIES) : [];
      } catch {
        return [];
      }
    },
    save(pending) {
      try {
        const open = pending.filter(entry => entry.phase !== 'accepted');
        if (open.length === 0) storage?.removeItem(key);
        else storage?.setItem(key, JSON.stringify(open.slice(0, MAX_ENTRIES)));
      } catch {
        /* Storage is best-effort; the channel journal still holds the intent. */
      }
    },
  };
}
