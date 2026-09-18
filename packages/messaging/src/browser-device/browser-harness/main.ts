// Browser harness for browser-device.browser.spec.ts. It wires the production
// service to the production Web Locks and IndexedDB adapters. The engine is a
// test-only stand-in: non-extractable Web Crypto keys persisted in the reserved
// IndexedDB store. It shows the lifecycle over real browser storage; it is not the
// substrate SDK, which stays gated on G-SUBSTRATE (see KHA-141 for the Matrix proof).

import type { DeviceId, DeviceView, IdentityPort, OwnerId } from '@khala/contracts/messaging/index';
import {
  type CredentialResolution, type DeviceEngine, type DeviceEngineFactory, createBrowserDeviceService,
  createIndexedDbMarkerStore, createIndexedDbStoreFactory, createWebLockProvider, cryptoStoreName,
} from '../index';
import type { BrowserDeviceService } from '../service';

type Key = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
type Keys = { identity: { publicKey: Key; privateKey: Key }; room: Key };
type TestEngine = DeviceEngine & { keys: Keys };

type Req<T> = { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked?: (() => void) | null };
type Store = { get(key: string): Req<unknown>; put(value: unknown, key: string): Req<unknown> };
type Db = {
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: 'readonly' | 'readwrite'): { objectStore(name: string): Store; oncomplete: (() => void) | null; onerror: (() => void) | null };
  close(): void;
};
type Idb = { open(name: string, version?: number): Req<Db> & { onupgradeneeded: (() => void) | null }; deleteDatabase(name: string): Req<unknown> };

const idb = (globalThis as unknown as { indexedDB: Idb }).indexedDB;
const subtle = globalThis.crypto.subtle;

const done = <T>(req: Req<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new Error('blocked'));
});

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function openKeys(name: string): Promise<{ db: Db; keys: Keys; created: boolean }> {
  const req = idb.open(name, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('keys'); };
  const db = await done(req);
  const read = db.transaction('keys', 'readonly').objectStore('keys').get('keys');
  const existing = (await done(read)) as Keys | undefined;
  if (existing) return { db, keys: existing, created: false };
  const keys: Keys = {
    identity: await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
    room: await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  };
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(keys, 'keys');
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('write failed')); });
  return { db, keys, created: true };
}

const engines: DeviceEngineFactory = {
  async open({ store }) {
    const { db, keys, created } = await openKeys(store.name);
    const engine: TestEngine = {
      keys,
      async identity() {
        return { fingerprint: hex(await subtle.digest('SHA-256', await subtle.exportKey('spki', keys.identity.publicKey))), created };
      },
      async start() { /* no network in the harness */ },
      async close() { db.close(); },
    };
    return engine;
  },
};

let service: BrowserDeviceService | null = null;
let credentials: CredentialResolution = { kind: 'unavailable' };
let ownerId = 'owner_alice' as OwnerId;

function build(lockWaitMs: number): BrowserDeviceService {
  const identity: IdentityPort = {
    current: async () => ({
      kind: 'signed_in',
      principal: {
        v: 1, ownerId, providerIssuer: 'https://idp.example', providerSubject: `sub-${ownerId}`,
        verifiedEmail: 'owner@example.com', sessionExpiresAt: '2030-01-01T00:00:00Z',
      },
    }),
    beginSignIn: async () => ({ kind: 'rejected', code: 'invalid_return_path' }),
    signOut: async () => ({ kind: 'ok', value: null }),
  };
  return createBrowserDeviceService({
    identity,
    credentials: { resolve: async () => credentials },
    stores: createIndexedDbStoreFactory(),
    engines,
    markers: createIndexedDbMarkerStore(),
    locks: createWebLockProvider(),
    lockWaitMs,
  });
}

const harness = {
  /** Resolves with the ensureReady result; creates the tab's service on first use. */
  async ensure(input: { ownerId: string; deviceId: string; publishedFingerprint: string | null; lockWaitMs: number }) {
    ownerId = input.ownerId as OwnerId;
    credentials = { kind: 'ok', session: { deviceId: input.deviceId as DeviceId, publishedFingerprint: input.publishedFingerprint, credentials: null } };
    service ??= build(input.lockWaitMs);
    return service.ensureReady(ownerId);
  },
  current: (): DeviceView | null => service?.current() ?? null,
  async fingerprint() {
    const result = await service!.use(async ({ engine }) => (await engine.identity()).fingerprint);
    return result.kind === 'ok' ? result.value : null;
  },
  async encrypt(text: string) {
    const result = await service!.use(async ({ engine }) => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, (engine as TestEngine).keys.room, new TextEncoder().encode(text));
      return `${b64(iv)}.${b64(sealed)}`;
    });
    return result.kind === 'ok' ? result.value : null;
  },
  /** `{ kind: 'rejected' }` when not ready; `{ kind: 'undecryptable' }` when keys do not match. */
  async decrypt(event: string) {
    const [iv = '', sealed = ''] = event.split('.');
    const result = await service!.use(async ({ engine }) => {
      try {
        const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, (engine as TestEngine).keys.room, unb64(sealed));
        return { kind: 'plaintext' as const, text: new TextDecoder().decode(plain) };
      } catch {
        return { kind: 'undecryptable' as const };
      }
    });
    return result.kind === 'ok' ? result.value : { kind: 'rejected' as const };
  },
  /** Stops the service and deletes the crypto store, keeping the identity marker. */
  async clearCryptoStore(input: { ownerId: string; deviceId: string }) {
    await service?.stop();
    await done(idb.deleteDatabase(cryptoStoreName(input.ownerId as OwnerId, input.deviceId as DeviceId)));
  },
  async clearMarkers() {
    await service?.stop();
    await done(idb.deleteDatabase('khala.browser-device.markers'));
  },
};

(globalThis as unknown as { khalaDevice: typeof harness }).khalaDevice = harness;
