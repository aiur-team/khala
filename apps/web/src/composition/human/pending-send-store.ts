import type { DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/ids';
import type { PendingSendStore } from '../../features/timeline/TimelineScreen';
import type { PendingSend } from '../../features/timeline/send';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): StoragePort | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

function isPendingSend(value: unknown): value is PendingSend {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const content = entry.content;
  return Object.keys(entry).sort().join(',') === 'clientTxnId,content,phase'
    && typeof entry.clientTxnId === 'string' && /^txn_[A-Za-z0-9-]{1,128}$/u.test(entry.clientTxnId)
    && ['pending', 'accepted', 'failed', 'outcome_unknown'].includes(String(entry.phase))
    && typeof content === 'object' && content !== null && !Array.isArray(content)
    && (content as Record<string, unknown>).v === 1
    && (content as Record<string, unknown>).kind === 'text'
    && typeof (content as Record<string, unknown>).body === 'string';
}

/** One tab's unresolved sends, scoped to the signed-in owner, exact device and channel. */
export function createHumanPendingSendStore(ownerId: OwnerId, deviceId: DeviceId, roomId: RoomId,
  storage: StoragePort | null = browserStorage()): PendingSendStore {
  const key = `khala.pending-send.v2:${JSON.stringify([ownerId, deviceId, roomId])}`;
  return {
    load() {
      if (!storage) return [];
      try {
        const raw = storage.getItem(key);
        if (raw === null) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length > 100 || !parsed.every(isPendingSend)) throw new Error('invalid pending sends');
        return parsed;
      } catch {
        try { storage.removeItem(key); } catch { /* unavailable storage */ }
        return [];
      }
    },
    save(pending) {
      if (!storage) return;
      try {
        if (pending.length === 0) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify(pending));
      } catch { /* The visible pending row still preserves the retry until this tab closes. */ }
    },
  };
}
