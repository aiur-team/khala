// Test doubles for the browser device lifecycle. Not exported from `index.ts`.
// `Disk` stands in for one browser profile: crypto stores and identity markers
// survive a new service instance (a restart) until a test clears them.

import type { AuthPrincipal, DeviceId, IdentityPort, IdentityState, OwnerId } from '@khala/contracts/messaging/index';
import type {
  BrowserDeviceDependencies, CredentialResolution, CryptoStoreFactory, DeviceEngine, DeviceEngineFactory, EngineOpenInput,
  IdentityMarker, IdentityMarkerStore,
} from './lifecycle';
import { type LockManagerLike, createWebLockProvider } from './ownership';

export const owner = (id: string) => id as OwnerId;
export const device = (id: string) => id as DeviceId;

export function principal(ownerId: string): AuthPrincipal {
  return {
    v: 1, ownerId: owner(ownerId), providerIssuer: 'https://idp.example', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.com`, sessionExpiresAt: '2030-01-01T00:00:00Z',
  };
}

export type Disk = {
  /** Crypto store name -> identity fingerprint held in it. */
  stores: Map<string, string>;
  markers: Map<OwnerId, IdentityMarker>;
  locks: LockManagerLike;
};

export function createDisk(): Disk {
  return { stores: new Map(), markers: new Map(), locks: createMemoryLockManager() };
}

/** In-memory exclusive Web Locks: FIFO waiters, abort by signal, release when the callback settles. */
export function createMemoryLockManager(): LockManagerLike {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const release = (name: string) => {
    held.delete(name);
    const next = queues.get(name)?.shift();
    if (next) next();
  };
  return {
    request(name, options, callback) {
      return new Promise<void>((resolve, reject) => {
        const grant = () => {
          held.add(name);
          options.signal?.removeEventListener('abort', onAbort);
          callback({ name }).then(() => { release(name); resolve(); }, error => { release(name); reject(error); });
        };
        const onAbort = () => {
          const queue = queues.get(name) ?? [];
          const index = queue.indexOf(grant);
          if (index >= 0) queue.splice(index, 1);
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (options.signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
        if (!held.has(name)) { grant(); return; }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        queues.set(name, [...(queues.get(name) ?? []), grant]);
      });
    },
  };
}

export function fakeIdentity(initial: IdentityState) {
  let state = initial;
  const port: IdentityPort = {
    current: async () => state,
    beginSignIn: async () => ({ kind: 'rejected', code: 'invalid_return_path' }),
    signOut: async () => ({ kind: 'ok', value: null }),
  };
  return { port, set(next: IdentityState) { state = next; }, signIn(ownerId: string) { state = { kind: 'signed_in', principal: principal(ownerId) }; } };
}

export type EngineLog = string[];

export type FakeEngine = DeviceEngine & { input: EngineOpenInput; started: boolean; closed: boolean };

export type EngineOptions = {
  failOpen?: boolean;
  failStart?: boolean;
  /** Runs inside `start` before it resolves, for injecting mid-initialisation events. */
  onStart?: (engine: FakeEngine) => Promise<void> | void;
};

let fingerprints = 0;

/** Keys persist in `disk.stores`; opening an empty store generates a new fingerprint. */
export function fakeEngines(disk: Disk, log: EngineLog, options: EngineOptions = {}) {
  const opened: FakeEngine[] = [];
  const factory: DeviceEngineFactory = {
    async open(input) {
      log.push(`open:${input.ownerId}`);
      if (options.failOpen) throw new Error('sdk setup failed: secret-looking detail');
      const existing = disk.stores.get(input.store.name);
      const fingerprint = existing ?? `fp-${++fingerprints}`;
      if (!existing) disk.stores.set(input.store.name, fingerprint);
      const engine: FakeEngine = {
        input,
        started: false,
        closed: false,
        identity: async () => ({ fingerprint, created: !existing }),
        async start() {
          log.push(`start:${input.ownerId}`);
          await options.onStart?.(engine);
          if (options.failStart) throw new Error('start failed');
          engine.started = true;
        },
        async close() {
          log.push(`close:${input.ownerId}`);
          engine.closed = true;
        },
      };
      opened.push(engine);
      return engine;
    },
  };
  return { factory, opened };
}

export function fakeStores(log: EngineLog, options: { fail?: boolean } = {}): CryptoStoreFactory {
  return {
    async open(ownerId, deviceId) {
      if (options.fail) throw new Error('quota');
      log.push(`store:${ownerId}`);
      return { name: `store.${ownerId}.${deviceId}`, close: async () => { log.push(`store-close:${ownerId}`); } };
    },
  };
}

export function fakeMarkers(disk: Disk, options: { failPut?: boolean } = {}): IdentityMarkerStore {
  return {
    get: async ownerId => disk.markers.get(ownerId) ?? null,
    async put(ownerId, marker) {
      if (options.failPut) throw new DOMException('quota exceeded', 'QuotaExceededError');
      disk.markers.set(ownerId, marker);
    },
    clear: async ownerId => { disk.markers.delete(ownerId); },
  };
}

/** Credentials per owner; a function lets a test hold resolution open. */
export function fakeCredentials(table: Record<string, CredentialResolution | (() => Promise<CredentialResolution>)>) {
  return {
    async resolve(p: AuthPrincipal) {
      const entry = table[p.ownerId];
      if (!entry) return { kind: 'unavailable' } as const;
      return typeof entry === 'function' ? entry() : entry;
    },
  };
}

export const session = (deviceId: string, publishedFingerprint: string | null = null): CredentialResolution =>
  ({ kind: 'ok', session: { deviceId: device(deviceId), publishedFingerprint, credentials: { token: 'opaque' } } });

export type Rig = {
  deps: BrowserDeviceDependencies;
  log: EngineLog;
  engines: FakeEngine[];
  identity: ReturnType<typeof fakeIdentity>;
};

/** One tab over `disk`, signed in as `ownerId` unless `identity` is given. */
export function rig(disk: Disk, options: {
  ownerId?: string;
  credentials?: Parameters<typeof fakeCredentials>[0];
  engine?: EngineOptions;
  stores?: { fail?: boolean };
  markers?: { failPut?: boolean };
  lockWaitMs?: number;
  locks?: BrowserDeviceDependencies['locks'];
} = {}): Rig {
  const log: EngineLog = [];
  const identity = fakeIdentity({ kind: 'signed_in', principal: principal(options.ownerId ?? 'owner_alice') });
  const engines = fakeEngines(disk, log, options.engine);
  return {
    log,
    identity,
    engines: engines.opened,
    deps: {
      identity: identity.port,
      credentials: fakeCredentials(options.credentials ?? { owner_alice: session('DEVICE_A') }),
      stores: fakeStores(log, options.stores),
      engines: engines.factory,
      markers: fakeMarkers(disk, options.markers),
      locks: options.locks ?? createWebLockProvider(disk.locks),
      lockWaitMs: options.lockWaitMs ?? 50,
    },
  };
}
