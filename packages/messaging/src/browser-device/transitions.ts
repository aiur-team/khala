// One lifecycle generation: the lease, store and engine opened for one owner. Account
// switch, sign-out, expiry and revocation all end a generation the same way:
// invalidate first, so no late SDK callback can publish into its replacement, then
// wipe projections, then close the engine, the store and the lease, in that order.

import type { DeviceId, Disposer, OwnerId } from '@khala/contracts/messaging/index';
import type { CryptoStore, DeviceEngine } from './lifecycle';
import type { OwnerLease } from './ownership';

export type Generation = {
  readonly ownerId: OwnerId;
  readonly generation: number;
  readonly abort: AbortController;
  deviceId: DeviceId | null;
  lease: OwnerLease | null;
  store: CryptoStore | null;
  engine: DeviceEngine | null;
  readonly disposers: Set<() => void>;
  /** Resolves once the generation's resources are closed. */
  closed: Promise<void> | null;
};

export class Superseded extends Error {
  constructor() {
    super('device generation superseded');
  }
}

export function openGeneration(ownerId: OwnerId, generation: number, deviceId: DeviceId | null): Generation {
  return { ownerId, generation, abort: new AbortController(), deviceId, lease: null, store: null, engine: null, disposers: new Set(), closed: null };
}

export const isLive = (g: Generation): boolean => !g.abort.signal.aborted;

/**
 * Ends a generation. Idempotent; resolves after every resource it held is closed.
 * Close failures are swallowed: the generation is already unreachable, and a
 * failing close must not keep a replacement from starting.
 */
export function endGeneration(g: Generation): Promise<void> {
  if (g.closed) return g.closed;
  g.abort.abort();
  const disposers = [...g.disposers];
  g.disposers.clear();
  for (const dispose of disposers) {
    try { dispose(); } catch { /* projection wipe failures cannot resurrect the generation */ }
  }
  g.closed = closeResources(g);
  return g.closed;
}

async function closeResources(g: Generation): Promise<void> {
  const { engine, store, lease } = g;
  g.engine = null;
  g.store = null;
  g.lease = null;
  if (engine) await engine.close().catch(() => undefined);
  if (store) await store.close().catch(() => undefined);
  lease?.release();
}

/**
 * Attaches a resource opened by an in-flight step. If the generation ended while
 * the step was pending, the resource is closed at once and the step is abandoned.
 */
export async function adopt<K extends 'lease' | 'store' | 'engine'>(g: Generation, key: K, resource: NonNullable<Generation[K]>): Promise<void> {
  if (isLive(g)) {
    g[key] = resource;
    return;
  }
  if (key === 'lease') (resource as OwnerLease).release();
  else await (resource as CryptoStore | DeviceEngine).close().catch(() => undefined);
  throw new Superseded();
}

/** Wraps an SDK callback so it runs only while its generation is live. */
export function guard<Args extends unknown[]>(g: Generation, callback: (...args: Args) => void): (...args: Args) => void {
  return (...args) => {
    if (isLive(g)) callback(...args);
  };
}

/** Registers a projection wipe that runs when the generation ends, before the engine closes. */
export function onEnd(g: Generation, dispose: () => void): Disposer {
  if (!isLive(g)) {
    dispose();
    return () => undefined;
  }
  g.disposers.add(dispose);
  return () => { g.disposers.delete(dispose); };
}
