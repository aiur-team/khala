// The IndexedDB adapters against a scripted IndexedDB. Unlike a real browser, it lets
// a test abort a transaction after its request already succeeded, the way a quota
// failure surfaces at commit.

import { describe, expect, it } from 'vitest';
import { device, owner } from './fakes';
import { type IndexedDbLike, createIndexedDbMarkerStore, createIndexedDbStoreFactory, cryptoStoreName } from './storage';

const alice = owner('owner_alice');
const bob = owner('owner_bob');
const signal = new AbortController().signal;

type Script = {
  /** Database names whose open request fails, as in some private modes. */
  failOpen?: (name: string) => boolean;
  /** Aborts every readwrite transaction at commit with this error. */
  abortCommit?: unknown;
};

function scriptedIndexedDb(script: Script = {}) {
  const databases = new Map<string, Map<string, unknown>>();
  const log: string[] = [];
  const later = (run: () => void) => { setTimeout(run, 0); };

  function request<T>(run: () => T) {
    const req = { result: undefined as T, error: null as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    later(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  }

  function database(name: string) {
    const data = databases.get(name)!;
    return {
      createObjectStore: () => undefined,
      close: () => { log.push(`close:${name}`); },
      transaction(_store: string, mode: 'readonly' | 'readwrite') {
        const staged = new Map(data);
        const tx = {
          error: null as unknown,
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          objectStore: () => ({
            get: (key: string) => request(() => staged.get(key)),
            put: (value: unknown, key: string) => request(() => { staged.set(key, value); }),
            delete: (key: string) => request(() => { staged.delete(key); }),
          }),
        };
        // Commit after the request has settled.
        later(() => later(() => {
          if (mode === 'readwrite' && script.abortCommit !== undefined) {
            tx.error = script.abortCommit;
            tx.onabort?.();
            return;
          }
          data.clear();
          for (const [key, value] of staged) data.set(key, value);
          log.push(`commit:${name}`);
          tx.oncomplete?.();
        }));
        return tx;
      },
    };
  }

  const factory: IndexedDbLike = {
    open(name) {
      log.push(`open:${name}`);
      const req = {
        result: undefined as unknown, error: null as unknown,
        onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onupgradeneeded: null as (() => void) | null,
      };
      later(() => {
        if (script.failOpen?.(name)) {
          req.error = new DOMException('blocked', 'InvalidStateError');
          req.onerror?.();
          return;
        }
        const created = !databases.has(name);
        if (created) databases.set(name, new Map());
        req.result = database(name);
        if (created) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as ReturnType<IndexedDbLike['open']>;
    },
    deleteDatabase(name) {
      log.push(`delete:${name}`);
      return request(() => { databases.delete(name); }) as ReturnType<IndexedDbLike['deleteDatabase']>;
    },
  };
  return { factory, databases, log };
}

describe('createIndexedDbStoreFactory', () => {
  it('refuses without IndexedDB instead of falling back to memory', async () => {
    await expect(createIndexedDbStoreFactory(null, null).open(alice, device('DEVICE_A'), signal)).rejects.toThrow('indexeddb unavailable');
    // Node has no global IndexedDB, so the default adapter refuses too.
    await expect(createIndexedDbStoreFactory().open(alice, device('DEVICE_A'), signal)).rejects.toThrow('indexeddb unavailable');
  });

  it('probes the store name, removes the probe and requests persistence', async () => {
    const idb = scriptedIndexedDb();
    let persisted = 0;
    const factory = createIndexedDbStoreFactory(idb.factory, { persist: async () => { persisted += 1; return true; } });

    const store = await factory.open(alice, device('DEVICE_A'), signal);

    const name = cryptoStoreName(alice, device('DEVICE_A'));
    expect(store.name).toBe(name);
    expect(idb.log).toEqual([`open:${name}.probe`, `close:${name}.probe`, `delete:${name}.probe`]);
    expect(idb.databases.size).toBe(0);
    expect(persisted).toBe(1);
  });

  it('refuses when the probe cannot open', async () => {
    const idb = scriptedIndexedDb({ failOpen: name => name.endsWith('.probe') });
    const factory = createIndexedDbStoreFactory(idb.factory, null);

    await expect(factory.open(alice, device('DEVICE_A'), signal)).rejects.toThrow('blocked');
  });

  it('still opens when persistence is refused', async () => {
    const idb = scriptedIndexedDb();
    const factory = createIndexedDbStoreFactory(idb.factory, { persist: () => Promise.reject(new Error('denied')) });

    await expect(factory.open(alice, device('DEVICE_A'), signal)).resolves.toMatchObject({ name: cryptoStoreName(alice, device('DEVICE_A')) });
  });

  it('names one store per owner and device', async () => {
    const factory = createIndexedDbStoreFactory(scriptedIndexedDb().factory, null);
    const names = await Promise.all([
      factory.open(alice, device('DEVICE_A'), signal),
      factory.open(alice, device('DEVICE_B'), signal),
      factory.open(bob, device('DEVICE_A'), signal),
    ]).then(stores => stores.map(store => store.name));

    expect(new Set(names).size).toBe(3);
    // Separators in ids cannot make two owners' names collide.
    expect(cryptoStoreName(owner('a.b'), device('c'))).not.toBe(cryptoStoreName(owner('a'), device('b.c')));
  });
});

describe('createIndexedDbMarkerStore', () => {
  it('round-trips a marker per owner and clears it', async () => {
    const markers = createIndexedDbMarkerStore(scriptedIndexedDb().factory);

    await markers.put(alice, { deviceId: device('DEVICE_A'), fingerprint: 'fp-a' });
    await markers.put(bob, { deviceId: device('DEVICE_B'), fingerprint: 'fp-b' });

    expect(await markers.get(alice)).toEqual({ deviceId: 'DEVICE_A', fingerprint: 'fp-a' });
    await markers.clear(alice);
    expect(await markers.get(alice)).toBeNull();
    expect(await markers.get(bob)).toEqual({ deviceId: 'DEVICE_B', fingerprint: 'fp-b' });
  });

  it('rejects a write whose transaction aborts at commit, and persists nothing', async () => {
    const quota = new DOMException('quota exceeded', 'QuotaExceededError');
    const idb = scriptedIndexedDb({ abortCommit: quota });
    const markers = createIndexedDbMarkerStore(idb.factory);

    await expect(markers.put(alice, { deviceId: device('DEVICE_A'), fingerprint: 'fp-a' })).rejects.toBe(quota);
    expect(await markers.get(alice)).toBeNull();
  });

  it('resolves a write only after its transaction commits', async () => {
    const idb = scriptedIndexedDb();
    const markers = createIndexedDbMarkerStore(idb.factory);

    await markers.put(alice, { deviceId: device('DEVICE_A'), fingerprint: 'fp-a' });

    expect(idb.log).toContain('commit:khala.browser-device.markers');
  });

  it('reads a malformed marker as absent', async () => {
    const idb = scriptedIndexedDb();
    const markers = createIndexedDbMarkerStore(idb.factory);
    await markers.put(alice, { deviceId: device('DEVICE_A'), fingerprint: 'fp-a' });
    idb.databases.get('khala.browser-device.markers')!.set(alice, { deviceId: 7 });

    expect(await markers.get(alice)).toBeNull();
  });

  it('rejects without IndexedDB', async () => {
    await expect(createIndexedDbMarkerStore(null).get(alice)).rejects.toThrow('indexeddb unavailable');
  });
});
