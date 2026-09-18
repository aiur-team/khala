// Cross-tab ownership of an owner's crypto store. The SDK store tolerates a single
// live client, and a module singleton cannot coordinate tabs, so one browser-wide
// exclusive lock gates every mutation-capable client. A tab without the lock never
// opens the store: it waits a bounded time and then reports failure.

import type { OwnerId } from '@khala/contracts/messaging/index';

export type OwnerLease = Readonly<{
  /** Releases the lock. Calling it more than once is harmless. */
  release(): void;
}>;

export type LockAcquisition =
  | Readonly<{ kind: 'acquired'; lease: OwnerLease }>
  /** Another holder kept the lock for the whole bounded wait. */
  | Readonly<{ kind: 'timeout' }>
  | Readonly<{ kind: 'aborted' }>
  /** No exclusive browser lock exists here. There is no unsafe fallback. */
  | Readonly<{ kind: 'unsupported' }>;

export interface OwnerLockProvider {
  acquire(ownerId: OwnerId, options: Readonly<{ waitMs: number; signal: AbortSignal }>): Promise<LockAcquisition>;
}

export const lockName = (ownerId: OwnerId): string => `khala.browser-device.${ownerId}`;

/** Structural subset of the Web Locks `LockManager`, so tests and workers can inject one. */
export type LockManagerLike = Readonly<{
  request(name: string, options: Readonly<{ mode: 'exclusive'; signal?: AbortSignal }>, callback: (lock: unknown) => Promise<void>): Promise<void>;
}>;

function defaultLockManager(): LockManagerLike | null {
  const scope = globalThis as { navigator?: { locks?: LockManagerLike } };
  return scope.navigator?.locks ?? null;
}

/**
 * Web Locks provider. The lock is held until the lease is released or the tab
 * terminates, at which point the browser hands it to the next waiter.
 */
export function createWebLockProvider(manager: LockManagerLike | null = defaultLockManager()): OwnerLockProvider {
  return {
    async acquire(ownerId, { waitMs, signal }) {
      if (!manager || typeof manager.request !== 'function') return { kind: 'unsupported' };
      if (signal.aborted) return { kind: 'aborted' };
      const wait = new AbortController();
      const timer = setTimeout(() => wait.abort(), waitMs);
      const onAbort = () => wait.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      return new Promise<LockAcquisition>(resolve => {
        let granted = false;
        manager.request(lockName(ownerId), { mode: 'exclusive', signal: wait.signal }, () => {
          granted = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          return new Promise<void>(done => {
            let released = false;
            resolve({ kind: 'acquired', lease: { release() { if (!released) { released = true; done(); } } } });
          });
        }).catch(() => {
          if (granted) return;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          // A rejection that no wait caused (for example a SecurityError on an
          // opaque origin) means locking is unavailable here.
          resolve(signal.aborted ? { kind: 'aborted' } : wait.signal.aborted ? { kind: 'timeout' } : { kind: 'unsupported' });
        });
      });
    },
  };
}
