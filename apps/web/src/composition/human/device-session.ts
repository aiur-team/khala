// Owns the single DevicePort lease used by the human application. The
// underlying browser-device service enforces cross-tab ownership; this layer
// prevents route remounts in one application from starting competing
// initialisations and serializes account replacement through stop().

import type {
  AuthPrincipal,
  DevicePort,
  DeviceRejection,
  DeviceView,
  Disposer,
  OperationResult,
  OwnerId,
} from '@khala/contracts/messaging/index';
import { sameProviderIdentity, unavailable } from '@khala/contracts/messaging/index';

export type DeviceActivation = OperationResult<DeviceView, DeviceRejection>;

export interface HumanDeviceSession {
  ensureReady(principal: AuthPrincipal): Promise<DeviceActivation>;
  current(): DeviceView | null;
  subscribe(listener: (view: DeviceView) => void): Disposer;
  release(): Promise<void>;
  dispose(): Promise<void>;
}

type InFlight = Readonly<{
  principal: AuthPrincipal;
  promise: Promise<DeviceActivation>;
}>;

function isReady(result: DeviceActivation): result is Readonly<{ kind: 'ok'; value: DeviceView }> {
  return result.kind === 'ok' && result.value.state === 'ready' && result.value.deviceId !== null;
}

export function createHumanDeviceSession(device: DevicePort): HumanDeviceSession {
  let epoch = 0;
  let ownerId: OwnerId | null = null;
  let principal: AuthPrincipal | null = null;
  let ready: DeviceActivation | null = null;
  let activeGeneration: number | null = null;
  let currentView: DeviceView | null = null;
  let inFlight: InFlight | null = null;
  let activationAbort: AbortController | null = null;
  let disposed = false;
  let stopChain = Promise.resolve();
  const listeners = new Set<(view: DeviceView) => void>();

  const removeDeviceObserver = device.observe(view => {
    if (disposed || ownerId === null || activeGeneration !== null && view.generation < activeGeneration) return;
    activeGeneration = view.generation;
    currentView = view;
    for (const listener of listeners) listener(view);
  });

  function stopSafely(): Promise<void> {
    stopChain = stopChain.then(() => device.stop()).catch(() => undefined);
    return stopChain;
  }

  function ensureReady(requestedPrincipal: AuthPrincipal): Promise<DeviceActivation> {
    if (disposed) return Promise.resolve(unavailable());
    if (principal && sameProviderIdentity(principal, requestedPrincipal) && ready && isReady(ready)) return Promise.resolve(ready);
    if (inFlight && sameProviderIdentity(inFlight.principal, requestedPrincipal)) return inFlight.promise;

    const replacingOwner = ownerId !== null || inFlight !== null;
    const requestedEpoch = ++epoch;
    activationAbort?.abort();
    activationAbort = new AbortController();
    const signal = activationAbort.signal;
    ready = null;
    activeGeneration = null;
    currentView = null;

    const entry: InFlight = {
      principal: requestedPrincipal,
      promise: (async () => {
        if (replacingOwner) await stopSafely();
        if (disposed || requestedEpoch !== epoch) return unavailable();

        ownerId = requestedPrincipal.ownerId;
        principal = requestedPrincipal;
        let result: DeviceActivation;
        try {
          result = await device.ensureReady(requestedPrincipal.ownerId, { signal });
        } catch {
          result = unavailable();
        }
        if (disposed || requestedEpoch !== epoch) return unavailable();
        if (isReady(result)) {
          const latest = device.current();
          const settled = latest.generation >= result.value.generation ? latest : result.value;
          currentView = settled;
          activeGeneration = settled.generation;
          ready = settled.state === 'ready' && settled.deviceId !== null ? { kind: 'ok', value: settled } : null;
          if (ready === null) return unavailable();
        }
        return result;
      })(),
    };
    inFlight = entry;
    void entry.promise.finally(() => {
      if (inFlight === entry) inFlight = null;
    });
    return entry.promise;
  }

  async function release(): Promise<void> {
    const heldLease = ownerId !== null || inFlight !== null;
    epoch += 1;
    activationAbort?.abort();
    activationAbort = null;
    ownerId = null;
    principal = null;
    ready = null;
    activeGeneration = null;
    currentView = null;
    inFlight = null;
    if (heldLease) await stopSafely();
  }

  return {
    ensureReady,

    current: () => currentView,

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    release,

    async dispose() {
      if (disposed) return;
      disposed = true;
      removeDeviceObserver();
      listeners.clear();
      await release();
    },
  };
}
