// One lifecycle generation: the lease, store and engine opened for one owner. Account
// switch, sign-out, expiry and revocation all end a generation the same way:
// invalidate first, so no late SDK callback can publish into its replacement, then
// wipe projections, then close the engine, the store and the lease, in that order.

import type { AuthPrincipal, DeviceId, Disposer, OwnerId } from '@khala/contracts/messaging/index';
import type { CryptoStore, DeviceEngine } from './lifecycle';
import type { OwnerLease } from './ownership';

export type Generation = {
  readonly ownerId: OwnerId;
  /** The signed-in principal this generation was opened for. */
  readonly principal: AuthPrincipal;
  readonly generation: number;
  readonly abort: AbortController;
  deviceId: DeviceId | null;
  lease: OwnerLease | null;
  store: CryptoStore | null;
  engine: DeviceEngine | null;
  readonly disposers: Set<() => void>;
  /** Setup steps that were given up on and may still be running. See `step`. */
  readonly stragglers: Set<Promise<void>>;
};

export class Superseded extends Error {
  constructor() {
    super('device generation superseded');
  }
}

export function openGeneration(principal: AuthPrincipal, generation: number, deviceId: DeviceId | null): Generation {
  return {
    ownerId: principal.ownerId, principal, generation, abort: new AbortController(), deviceId,
    lease: null, store: null, engine: null, disposers: new Set(), stragglers: new Set(),
  };
}

export const isLive = (g: Generation): boolean => !g.abort.signal.aborted;

/** Resolves `true` if `promise` settles within `ms`, or `false` once the bound elapses. */
export function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => true, () => true).then(settled => {
      clearTimeout(timer);
      resolve(settled);
    });
  });
}

export class StepTimeout extends Error {
  constructor() {
    super('device setup step timed out');
  }
}

/**
 * Runs one setup step of `g` with a time limit. It settles like `promise`, but
 * rejects with `StepTimeout` once `ms` passes, so a step that never settles (a
 * blocked IndexedDB open, an unanswered permission prompt) cannot keep the tab
 * on "Getting this device ready".
 *
 * Giving up on a step does not stop it: an SDK open may still be writing the
 * crypto store. The step stays in `g.stragglers` until it has settled and any
 * resource it produced after the generation gave up on it has been closed by
 * `closeLate`. `closeResources` holds the owner's lock until then, so no other
 * tab, and no retry in this tab, can open the store as a second writer.
 */
export function step<T>(g: Generation, promise: Promise<T>, ms: number, closeLate?: (value: T) => Promise<unknown>): Promise<T> {
  if (!isLive(g)) return Promise.reject(new Superseded());
  let abandoned = false;
  const straggler: Promise<void> = promise.then(async value => {
    if (abandoned || !isLive(g)) await closeLate?.(value);
  }).then(() => undefined, () => undefined);
  g.stragglers.add(straggler);
  void straggler.then(() => { g.stragglers.delete(straggler); });
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abandoned = true;
      reject(new StepTimeout());
    }, ms);
    promise.then(value => {
      if (abandoned) return;
      clearTimeout(timer);
      // The generation ended while the step ran: its resource is closed by the
      // straggler above, and the step is abandoned.
      if (isLive(g)) resolve(value);
      else reject(new Superseded());
    }, (error: unknown) => {
      if (abandoned) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Ends a generation. The service detaches `g` before calling this, so it runs once
 * per generation. Resolves after every resource it held is closed, or once
 * `closeWaitMs` passes for an engine that will not close. Close failures are
 * swallowed: the generation is already unreachable, and a failing close must not
 * keep a replacement from starting.
 */
export function endGeneration(g: Generation, closeWaitMs: number): Promise<void> {
  g.abort.abort();
  const disposers = [...g.disposers];
  g.disposers.clear();
  for (const dispose of disposers) {
    try { dispose(); } catch { /* projection wipe failures cannot resurrect the generation */ }
  }
  return closeResources(g, closeWaitMs);
}

async function closeResources(g: Generation, closeWaitMs: number): Promise<void> {
  const { engine, store, lease } = g;
  g.engine = null;
  g.store = null;
  g.lease = null;
  // An engine that will not close may still be writing. Its store and lease stay
  // held so no other tab can become a second writer; closing the tab frees them.
  if (engine && !(await within(engine.close(), closeWaitMs))) return;
  const finish = async () => {
    if (store) await store.close().catch(() => undefined);
    lease?.release();
  };
  // A setup step that was given up on may still be writing the store. The lease
  // stays held until every such step has settled and its late resource closed;
  // one that never settles keeps it until the tab closes. The generation has
  // already ended, so nothing waits for this.
  const stragglers = [...g.stragglers];
  if (stragglers.length) void Promise.all(stragglers).then(finish);
  else await finish();
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
