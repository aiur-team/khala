// Browser storage adapters. The identity marker lives in its own IndexedDB database,
// apart from the SDK crypto store, so clearing the crypto store alone is detected as
// loss instead of silently becoming a fresh identity. Deleting the whole origin's
// storage removes both; the credential source's `publishedFingerprint` covers that case.

import type { DeviceId, OwnerId } from '@khala/contracts/messaging/index';
import type { CryptoStore, CryptoStoreFactory, IdentityMarker, IdentityMarkerStore } from './lifecycle';

// Structural subsets of the IndexedDB API. The package compiles without the DOM
// library, and these also let tests and workers inject an implementation.
type Req<T> = { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null };
type OpenReq = Req<Db> & { onupgradeneeded: (() => void) | null };
type ObjectStore = {
  get(key: string): Req<unknown>;
  put(value: unknown, key: string): Req<unknown>;
  delete(key: string): Req<unknown>;
};
type Tx = {
  objectStore(name: string): ObjectStore;
  error: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};
type Db = {
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: 'readonly' | 'readwrite', options?: { durability?: 'strict' }): Tx;
  close(): void;
};
export type IndexedDbLike = {
  open(name: string, version?: number): OpenReq;
  deleteDatabase(name: string): Req<unknown>;
};

const MARKER_DB = 'khala.browser-device.markers';
const MARKER_STORE = 'markers';

const scope = globalThis as { indexedDB?: IndexedDbLike; navigator?: { storage?: StorageManagerLike } };

function request<T>(req: Req<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

function openMarkerDb(factory: IndexedDbLike): Promise<Db> {
  const req = factory.open(MARKER_DB, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(MARKER_STORE); };
  return request(req);
}

async function transact<T>(factory: IndexedDbLike, mode: 'readonly' | 'readwrite', run: (store: ObjectStore) => Req<T>): Promise<T> {
  const db = await openMarkerDb(factory);
  try {
    const tx = db.transaction(MARKER_STORE, mode, { durability: 'strict' });
    const result = request(run(tx.objectStore(MARKER_STORE)));
    // A write counts only once its transaction commits; quota errors surface here.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
    });
    return await result;
  } finally {
    db.close();
  }
}

function readMarker(value: unknown): IdentityMarker | null {
  if (typeof value !== 'object' || value === null) return null;
  const { deviceId, fingerprint } = value as Record<string, unknown>;
  if (typeof deviceId !== 'string' || typeof fingerprint !== 'string') return null;
  return { deviceId: deviceId as DeviceId, fingerprint };
}

export function createIndexedDbMarkerStore(factory: IndexedDbLike | null = scope.indexedDB ?? null): IdentityMarkerStore {
  const db = () => {
    if (!factory) throw new Error('indexeddb unavailable');
    return factory;
  };
  return {
    async get(ownerId) {
      return readMarker(await transact(db(), 'readonly', store => store.get(ownerId)));
    },
    async put(ownerId, marker) {
      await transact(db(), 'readwrite', store => store.put({ deviceId: marker.deviceId, fingerprint: marker.fingerprint }, ownerId));
    },
    async clear(ownerId) {
      await transact(db(), 'readwrite', store => store.delete(ownerId));
    },
  };
}

/** Name the SDK uses for one owner's crypto database; distinct per owner and device. */
export const cryptoStoreName = (ownerId: OwnerId, deviceId: DeviceId): string =>
  `khala.crypto.${encodeURIComponent(ownerId)}.${encodeURIComponent(deviceId)}`;

type StorageManagerLike = Readonly<{ persist?(): Promise<boolean> }>;

/**
 * Reserves a persistent IndexedDB-backed crypto store. Refuses when IndexedDB is
 * missing or cannot open (for example some private modes): the SDK must never fall
 * back to an in-memory store that would look ready and then vanish on restart.
 * Persistence is requested but not required; eviction is reported later as loss.
 */
export function createIndexedDbStoreFactory(
  factory: IndexedDbLike | null = scope.indexedDB ?? null,
  storage: StorageManagerLike | null = scope.navigator?.storage ?? null,
): CryptoStoreFactory {
  return {
    async open(ownerId, deviceId): Promise<CryptoStore> {
      if (!factory) throw new Error('indexeddb unavailable');
      const name = cryptoStoreName(ownerId, deviceId);
      const probeName = `${name}.probe`;
      const probe = await request(factory.open(probeName));
      probe.close();
      await request(factory.deleteDatabase(probeName));
      await storage?.persist?.().catch(() => false);
      return { name, close: async () => undefined };
    },
  };
}
