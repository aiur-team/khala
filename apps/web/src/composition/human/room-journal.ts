import type { OwnerId } from '@khala/contracts/messaging/index';
import type { RoomJournal } from '@khala/messaging/rooms/index';

type JournalRecord = Parameters<RoomJournal['claim']>[1];

type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>;
type ExclusiveLocks = Readonly<{
  request<T>(name: string, options: Readonly<{ mode: 'exclusive' }>, callback: () => T | PromiseLike<T>): Promise<T>;
}>;

type StoredRecord = Readonly<{ revision: string; value: JournalRecord }>;

export type BrowserRoomJournalOptions = Readonly<{
  storage?: JournalStorage | null;
  locks?: ExclusiveLocks | null;
  newRevision?: () => string;
}>;

function browserStorage(): JournalStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function browserLocks(): ExclusiveLocks | null {
  const locks = globalThis.navigator?.locks;
  return locks ? locks as unknown as ExclusiveLocks : null;
}

function parseStored(value: string | null): StoredRecord | null | 'invalid' {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid';
    const envelope = parsed as Record<string, unknown>;
    const record = envelope.value;
    if (
      Object.keys(envelope).length !== 2
      || typeof envelope.revision !== 'string'
      || envelope.revision.length === 0
      || typeof record !== 'object'
      || record === null
      || Array.isArray(record)
      || !['create', 'send', 'intro'].includes(String((record as Record<string, unknown>).type))
    ) return 'invalid';
    return { revision: envelope.revision, value: record as JournalRecord };
  } catch {
    return 'invalid';
  }
}

/**
 * Persistent, owner-scoped operation journal. Web Locks make the localStorage
 * compare-and-set atomic across tabs, so a reload or concurrent retry reuses
 * the original room/message operation identity.
 */
export function createBrowserRoomJournal(ownerId: OwnerId, options: BrowserRoomJournalOptions = {}): RoomJournal {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const locks = options.locks === undefined ? browserLocks() : options.locks;
  const newRevision = options.newRevision ?? (() => crypto.randomUUID());
  // khala-terminology-allow: machine-only localStorage key namespace, never rendered
  const prefix = `khala.room-journal.v1:${encodeURIComponent(ownerId)}:`;

  async function exclusive<T>(key: string, unavailable: T, operation: (storageKey: string) => T): Promise<T> {
    if (!storage || !locks) return unavailable;
    const storageKey = `${prefix}${key}`;
    try {
      // khala-terminology-allow: machine-only Web Lock name, never rendered
      return await locks.request(`khala.room-journal:${storageKey}`, { mode: 'exclusive' }, () => operation(storageKey));
    } catch {
      return unavailable;
    }
  }

  function write(storageKey: string, value: JournalRecord): string {
    const revision = newRevision();
    storage!.setItem(storageKey, JSON.stringify({ revision, value } satisfies StoredRecord));
    return revision;
  }

  return {
    read(key) {
      return exclusive(key, { kind: 'unavailable' } as const, storageKey => {
        const found = parseStored(storage!.getItem(storageKey));
        if (found === 'invalid') return { kind: 'unavailable' } as const;
        return found === null
          ? { kind: 'absent' } as const
          : { kind: 'record', value: found.value, revision: found.revision } as const;
      });
    },
    claim(key, value) {
      return exclusive(key, { kind: 'unavailable' } as const, storageKey => {
        const found = parseStored(storage!.getItem(storageKey));
        if (found === 'invalid') return { kind: 'unavailable' } as const;
        if (found !== null) return { kind: 'exists', value: found.value, revision: found.revision } as const;
        return { kind: 'claimed', revision: write(storageKey, value) } as const;
      });
    },
    replace(key, expectedRevision, value) {
      return exclusive(key, { kind: 'unavailable' } as const, storageKey => {
        const found = parseStored(storage!.getItem(storageKey));
        if (found === 'invalid') return { kind: 'unavailable' } as const;
        if (found?.revision !== expectedRevision) return { kind: 'conflict' } as const;
        return { kind: 'stored', revision: write(storageKey, value) } as const;
      });
    },
  };
}
