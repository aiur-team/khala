// `DevicePort` for the browser. One service owns at most one live generation: one
// lease, one crypto store and one SDK client for one owner. Setup is automatic on
// the signed-in path and never mints a fresh keyset under a device ID whose keys
// were lost.

import {
  type AuthPrincipal, type CallOptions, type DeviceId, type DevicePort, type DeviceReason, type DeviceRejection,
  type DeviceView, type Disposer, type OperationResult, type OwnerId, ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import {
  type BrowserDeviceDependencies, type DeviceEngine, type EngineSignal, DEFAULT_LOCK_WAIT_MS, checkIdentity, deviceView,
} from './lifecycle';
import { type Generation, Superseded, adopt, endGeneration, guard, isLive, onEnd, openGeneration } from './transitions';

/** Handed to crypto operations; valid only for the generation that was ready when they began. */
export type EngineContext = Readonly<{
  ownerId: OwnerId;
  deviceId: DeviceId;
  generation: number;
  engine: DeviceEngine;
  /** Aborts when the generation ends. */
  signal: AbortSignal;
  /** Wraps an SDK callback so it is dropped once this generation ends. */
  guard<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void;
  /** Registers an in-memory projection wipe that runs before the engine closes. */
  onEnd(dispose: () => void): Disposer;
}>;

export interface BrowserDeviceService extends DevicePort {
  /**
   * Runs a crypto operation against the ready engine. Waits for an in-flight
   * `ensureReady`; otherwise refuses with `not_ready` rather than opening a client.
   */
  use<T>(operation: (context: EngineContext) => Promise<T>, options?: CallOptions): Promise<OperationResult<T, 'not_ready'>>;
  /**
   * Leaves `lost` after the approved recovery or re-enrolment flow (injected by its
   * owner, never started here) has accepted the loss. Clears the identity marker
   * only; the next `ensureReady` still refuses the old device ID with new keys.
   */
  acceptLoss(ownerId: OwnerId): Promise<OperationResult<DeviceView, 'owner_mismatch' | 'not_lost'>>;
}

type Ensure = Readonly<{ ownerId: OwnerId; promise: Promise<OperationResult<DeviceView, DeviceRejection>> }>;

export function createBrowserDeviceService(deps: BrowserDeviceDependencies): BrowserDeviceService {
  const lockWaitMs = deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const listeners = new Set<(view: DeviceView) => void>();
  let view = deviceView('new', 0, null);
  /** Owner the current view describes; `null` while `new`. */
  let viewOwner: OwnerId | null = null;
  let live: Generation | null = null;
  let inflight: Ensure | null = null;
  /** Advances on every ensure or stop request; only the newest may open a generation. */
  let epoch = 0;

  function publish(next: DeviceView, owner: OwnerId | null): DeviceView {
    view = next;
    viewOwner = owner;
    for (const listener of [...listeners]) {
      try { listener(next); } catch { /* one observer cannot stall the lifecycle */ }
    }
    return next;
  }

  /** Ends the live generation, if any, without publishing a view. */
  async function retire(): Promise<void> {
    const g = live;
    live = null;
    if (g) await endGeneration(g);
  }

  /** Ends `g` and publishes `next`, but only if `g` is still the live generation. */
  async function finish(g: Generation, next: DeviceView): Promise<DeviceView> {
    if (live !== g) throw new Superseded();
    live = null;
    publish(next, g.ownerId);
    await endGeneration(g);
    return next;
  }

  function onEngineSignal(g: Generation, signal: EngineSignal): void {
    if (live !== g) return;
    if (signal === 'revoked') void finish(g, deviceView('revoked', g.generation + 1, g.deviceId, 'revoked_by_owner')).catch(() => undefined);
    else if (signal === 'session_expired') void finish(g, locked(g.generation, g.deviceId)).catch(() => undefined);
    else void finish(g, deviceView('failed', g.generation, g.deviceId, 'storage_unavailable')).catch(() => undefined);
  }

  /** Signed out or expired: key material stays where it is, and nothing is deleted. */
  const locked = (generation: number, deviceId: DeviceId | null): DeviceView => deviceId
    ? deviceView('locked', generation, deviceId, 'signed_out')
    : deviceView('failed', generation, null, 'signed_out');

  async function signedOut(): Promise<DeviceView> {
    const deviceId = viewOwner ? view.deviceId : null;
    const owner = viewOwner;
    await retire();
    if (view.state === 'lost' || view.state === 'revoked') return view;
    return publish(locked(view.generation, deviceId), owner);
  }

  async function initialise(principal: AuthPrincipal, requested: number): Promise<OperationResult<DeviceView, DeviceRejection>> {
    const ownerId = principal.ownerId;
    const sameOwner = viewOwner === ownerId;
    if (sameOwner && live && view.state === 'ready') return ok(view);
    // Lost and revoked are sticky: retrying must not quietly mint a new keyset.
    if (sameOwner && (view.state === 'lost' || view.state === 'revoked')) return ok(view);

    // Account switch or re-initialisation: the previous generation ends before the
    // next one can open anything.
    while (live) await retire();
    if (requested !== epoch) return unavailable();
    const g = openGeneration(ownerId, view.generation + 1, sameOwner ? view.deviceId : null);
    live = g;
    publish(deviceView('initializing', g.generation, g.deviceId), ownerId);
    const fail = (reason: DeviceReason) => finish(g, deviceView('failed', g.generation, g.deviceId, reason));

    try {
      const acquisition = await deps.locks.acquire(ownerId, { waitMs: lockWaitMs, signal: g.abort.signal });
      if (acquisition.kind === 'unsupported') {
        await fail('unsupported_environment');
        return rejected('unsupported_environment');
      }
      if (acquisition.kind === 'aborted') throw new Superseded();
      if (acquisition.kind === 'timeout') {
        // Another tab owns this store. Never become a second writer.
        await fail('storage_unavailable');
        return unavailable();
      }
      await adopt(g, 'lease', acquisition.lease);

      const credentials = await deps.credentials.resolve(principal, g.abort.signal);
      if (!isLive(g)) throw new Superseded();
      if (credentials.kind === 'expired') return ok(await finish(g, locked(g.generation, g.deviceId)));
      if (credentials.kind === 'revoked') {
        g.deviceId = credentials.deviceId;
        return ok(await finish(g, deviceView('revoked', g.generation + 1, credentials.deviceId, 'revoked_by_owner')));
      }
      if (credentials.kind === 'unavailable') {
        await fail('initialization_failed');
        return unavailable();
      }
      const session = credentials.session;
      g.deviceId = session.deviceId;

      let store;
      try {
        store = await deps.stores.open(ownerId, session.deviceId, g.abort.signal);
      } catch {
        if (!isLive(g)) throw new Superseded();
        return ok(await fail('storage_unavailable'));
      }
      await adopt(g, 'store', store);

      let engine;
      try {
        engine = await deps.engines.open({
          ownerId, session, store, signal: g.abort.signal, emit: guard(g, signal => onEngineSignal(g, signal)),
        });
      } catch {
        // The store was adopted above, so ending the generation closes it.
        if (!isLive(g)) throw new Superseded();
        return ok(await fail('initialization_failed'));
      }
      await adopt(g, 'engine', engine);

      const [local, marker] = await Promise.all([engine.identity(), deps.markers.get(ownerId)]);
      if (!isLive(g)) throw new Superseded();
      const decision = checkIdentity(marker, session, local);
      if (typeof decision === 'object') {
        // The engine never started, so the replacement keys never left this tab.
        return ok(await finish(g, deviceView('lost', g.generation, session.deviceId, decision.lost)));
      }
      if (decision === 'enrol') {
        try {
          await deps.markers.put(ownerId, { deviceId: session.deviceId, fingerprint: local.fingerprint });
        } catch {
          if (!isLive(g)) throw new Superseded();
          return ok(await fail('storage_unavailable'));
        }
        if (!isLive(g)) throw new Superseded();
      }

      await engine.start(g.abort.signal);
      if (live !== g) throw new Superseded();
      return ok(publish(deviceView('ready', g.generation, session.deviceId), ownerId));
    } catch (error) {
      if (error instanceof Superseded || live !== g) {
        // A revocation, expiry or stop that ended this generation already published
        // the view that replaced it; an account switch left nothing for this owner.
        return viewOwner === ownerId && view.state !== 'initializing' ? ok(view) : unavailable();
      }
      return ok(await fail('initialization_failed'));
    }
  }

  async function ensure(ownerId: OwnerId): Promise<OperationResult<DeviceView, DeviceRejection>> {
    const requested = ++epoch;
    const identity = await deps.identity.current();
    if (requested !== epoch) return unavailable();
    if (identity.kind === 'unavailable') return unavailable();
    if (identity.kind === 'signed_out') return ok(await signedOut());
    if (identity.principal.ownerId !== ownerId) return rejected('owner_mismatch');
    return initialise(identity.principal, requested);
  }

  function track(ownerId: OwnerId): Ensure {
    if (inflight && inflight.ownerId === ownerId) return inflight;
    const entry: Ensure = {
      ownerId,
      promise: ensure(ownerId).finally(() => { if (inflight === entry) inflight = null; }),
    };
    inflight = entry;
    return entry;
  }

  return {
    async ensureReady(ownerId, options = {}) {
      const signal = options.signal;
      if (signal?.aborted) return unavailable();
      const { promise } = track(ownerId);
      if (!signal) return promise;
      // Aborting stops the caller's wait only; initialisation carries on.
      return new Promise(resolve => {
        const onAbort = () => resolve(outcomeUnknown(`browser-device:${ownerId}:${view.generation}`));
        signal.addEventListener('abort', onAbort, { once: true });
        void promise.then(result => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        });
      });
    },

    current: () => view,

    observe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    async stop() {
      epoch += 1;
      inflight = null;
      const next = deviceView('new', view.generation + 1, null);
      const retiring = retire();
      publish(next, null);
      await retiring;
    },

    async use(operation, options = {}) {
      const pending = inflight;
      if (pending) {
        const settled = pending.promise.then(() => true);
        const aborted = options.signal
          ? new Promise<false>(resolve => options.signal!.addEventListener('abort', () => resolve(false), { once: true }))
          : null;
        if (!(await (aborted ? Promise.race([settled, aborted]) : settled))) return unavailable();
      }
      const g = live;
      if (!g || !isLive(g) || view.state !== 'ready' || !g.engine || !g.deviceId) return rejected('not_ready');
      const context: EngineContext = {
        ownerId: g.ownerId,
        deviceId: g.deviceId,
        generation: g.generation,
        engine: g.engine,
        signal: g.abort.signal,
        guard: callback => guard(g, callback),
        onEnd: dispose => onEnd(g, dispose),
      };
      return ok(await operation(context));
    },

    async acceptLoss(ownerId) {
      if (viewOwner !== ownerId) return rejected('owner_mismatch');
      if (view.state !== 'lost') return rejected('not_lost');
      await deps.markers.clear(ownerId);
      return ok(publish(deviceView('new', view.generation, null), ownerId));
    },
  };
}
