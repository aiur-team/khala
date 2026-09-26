// Browser recovery composition (KHA-136). Adapts the real identity and device
// ports and the KHA-129 recovery service to the KHA-127 panel's `RecoveryUiPort`.
// P14: no history recovery and no escrow, so recovery always refuses without asking
// for a secret. P13: closure has no approved command yet, so it is never offered.

import {
  type AuthPrincipal, type DevicePort, type DeviceView, type IdentityPort, type IdentityState, type RecoveryCapabilities,
  type RevocationPort, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { createRecoveryService } from '@khala/messaging/recovery/index';
import type {
  HistoryAvailability, RecoveryConnection, RecoveryOperationReference, RecoveryPorts, RecoveryResumeStore, RecoverySnapshot,
  RecoveryUiPort, RevocationCapability,
} from '../../features/recovery/ports';

/**
 * Owner-scoped revocation, served by the control plane. `targets` lists only this owner's
 * devices and bindings with their current control-plane generation.
 */
export interface BrowserRevocation extends RevocationPort {
  targets(): readonly RevocationCapability[];
}

export type BrowserRecoveryDeps = Readonly<{
  principal: AuthPrincipal;
  identity: IdentityPort;
  /** Shared with the messaging lifecycle. This port observes it and never stops it. */
  device: DevicePort;
  /** Absent until the control plane serves revocation: no target is offered and `revoke` is unavailable. */
  revocation?: BrowserRevocation;
  resumeStore?: RecoveryResumeStore;
  connection?: () => RecoveryConnection;
}>;

export type BrowserRecoveryPorts = RecoveryPorts & Readonly<{
  /** Re-reads identity and recovery capability. Results from before a `dispose` are discarded. */
  refresh(): Promise<void>;
  /** Closes only this port's observers. The device and messaging lifecycle stay intact. */
  dispose(): void;
}>;

const PENDING: RecoveryCapabilities = { modes: [], unavailableReason: 'device_not_ready' };

/**
 * P14 recovers nothing, so a device never has `available` history: a ready device holds only what
 * arrived after its own admission.
 */
function historyOf(device: DeviceView): HistoryAvailability {
  return device.state === 'ready' ? 'partial' : 'unavailable';
}

export function memoryResumeStore(): RecoveryResumeStore {
  let stored: RecoveryOperationReference | null = null;
  return {
    load: () => stored,
    save: reference => { stored = reference; },
    clear: () => { stored = null; },
  };
}

export function createBrowserRecoveryPort(deps: BrowserRecoveryDeps): BrowserRecoveryPorts {
  const listeners = new Set<() => void>();
  let identity: IdentityState = { kind: 'unavailable', retryable: true };
  let recovery: RecoveryCapabilities = PENDING;
  let generation = 0;
  let disposed = false;
  let snapshot: RecoverySnapshot = build();

  const service = createRecoveryService({
    ownerId: deps.principal.ownerId,
    identity: {
      async current(options) {
        const state = await deps.identity.current(options);
        return state.kind === 'signed_in' ? { kind: 'signed_in', ownerId: state.principal.ownerId } : state;
      },
    },
  });

  function build(): RecoverySnapshot {
    const device = deps.device.current();
    return {
      identity,
      device,
      history: historyOf(device),
      connection: deps.connection?.() ?? 'unknown',
      recovery,
      revocationTargets: identity.kind === 'signed_in' ? deps.revocation?.targets() ?? [] : [],
      closure: null,
    };
  }

  function publish(): void {
    if (disposed) return;
    snapshot = build();
    for (const listener of [...listeners]) listener();
  }

  async function refresh(): Promise<void> {
    const own = ++generation;
    let nextIdentity: IdentityState;
    let nextRecovery: RecoveryCapabilities;
    try {
      [nextIdentity, nextRecovery] = await Promise.all([deps.identity.current(), service.capabilities()]);
    } catch {
      nextIdentity = { kind: 'unavailable', retryable: true };
      nextRecovery = PENDING;
    }
    if (disposed || own !== generation) return;
    identity = nextIdentity;
    recovery = nextRecovery;
    publish();
  }

  const stopObserving = deps.device.observe(view => {
    // A view from a replaced device generation is stale and never shown.
    if (view.generation !== deps.device.current().generation) return;
    publish();
    void refresh();
  });

  const ui: RecoveryUiPort = {
    snapshot: () => snapshot,
    subscribe(listener, signal) {
      if (disposed || signal.aborted) return () => {};
      listeners.add(listener);
      const remove = () => {
        listeners.delete(listener);
        signal.removeEventListener('abort', remove);
      };
      signal.addEventListener('abort', remove, { once: true });
      return remove;
    },
    beginRecovery: (input, provideSecret, options) => service.begin(input, provideSecret, options),
    inspectRecovery: (operationId, options) => service.inspect(operationId, options),
    async revoke(input, options) {
      if (!deps.revocation || disposed) return unavailable();
      return deps.revocation.revoke(input, options);
    },
    async inspectRevocation(operationId, options) {
      if (!deps.revocation || disposed) return unavailable();
      return deps.revocation.inspect(operationId, options);
    },
    // No approved closure command exists (KHA-130). Nothing here calls storage deletion instead.
    async closeRoom() {
      return unavailable();
    },
    async inspectClosure() {
      return rejected('not_found');
    },
  };

  void refresh();

  return {
    ui,
    resumeStore: deps.resumeStore ?? memoryResumeStore(),
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      stopObserving();
      listeners.clear();
    },
  };
}
