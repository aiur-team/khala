// Browser recovery composition (KHA-136). Adapts the real identity and device
// ports and the KHA-129 recovery service to the KHA-127 panel's `RecoveryUiPort`.
// P14: no history recovery and no escrow, so recovery always refuses without asking
// for a secret. P13 closure is available only through the owner-scoped control port.

import {
  type AuthPrincipal, type ClosureCapability, type ClosurePort, type DevicePort, type DeviceView, type IdentityPort, type IdentityState, type RecoveryCapabilities,
  type RevocationPort, type RoomId, rejected, sameProviderIdentity, unavailable,
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
  targets(): readonly RevocationCapability[] | Promise<readonly RevocationCapability[]>;
}

/** The currently selected owner's channel, resolved by the control plane. */
export interface BrowserClosure extends Pick<ClosurePort, 'closeRoom' | 'inspectClosure'> {
  currentCapability(): Promise<ClosureCapability | null>;
}

export type BrowserRecoveryDeps = Readonly<{
  principal: AuthPrincipal;
  identity: IdentityPort;
  /** Shared with the messaging lifecycle. This port observes it and never stops it. */
  device: DevicePort;
  /** Absent until the control plane serves revocation: no target is offered and `revoke` is unavailable. */
  revocation?: BrowserRevocation;
  /** Absent until the protected human closure route and its service are registered. */
  closure?: BrowserClosure;
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

/** Persist only the operation identity within this tab so reloads inspect rather than restart it. */
export function sessionResumeStore(ownerId: AuthPrincipal['ownerId'], roomId: RoomId,
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null): RecoveryResumeStore {
  const key = `khala.recovery.resume.v1:${JSON.stringify([ownerId, roomId])}`;
  const storage = () => {
    if (session) return session;
    try { return globalThis.sessionStorage; } catch { return null; }
  };
  return {
    load() {
      let raw: string | null;
      try { raw = storage()?.getItem(key) ?? null; } catch { return null; }
      if (raw === null) return null;
      try {
        if (raw.length > 1024) throw new Error('oversized');
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid');
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(',') !== 'deviceGeneration,deviceId,kind,operationId,ownerId,roomId,roomRevision'
          || !['recovery', 'revocation', 'closure'].includes(String(row.kind))
          || typeof row.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(row.operationId)
          || row.ownerId !== ownerId || row.roomId !== roomId
          || row.deviceId !== null && typeof row.deviceId !== 'string'
          || !Number.isSafeInteger(row.deviceGeneration) || (row.deviceGeneration as number) < 0
          || !Number.isSafeInteger(row.roomRevision) || (row.roomRevision as number) < 0) throw new Error('invalid');
        return row as RecoveryOperationReference;
      } catch {
        try { storage()?.removeItem(key); } catch { /* unavailable storage stays fail closed */ }
        return null;
      }
    },
    save(reference) {
      if (reference.ownerId !== ownerId || reference.roomId !== roomId) throw new Error('recovery_resume_scope_mismatch');
      const target = storage();
      if (!target) throw new Error('recovery_resume_storage_unavailable');
      const safe: RecoveryOperationReference = {
        kind: reference.kind, operationId: reference.operationId, ownerId: reference.ownerId,
        deviceId: reference.deviceId, deviceGeneration: reference.deviceGeneration,
        roomId: reference.roomId, roomRevision: reference.roomRevision,
      };
      target.setItem(key, JSON.stringify(safe));
    },
    clear() { try { storage()?.removeItem(key); } catch { /* inspection remains safe on reload */ } },
  };
}

export function createBrowserRecoveryPort(deps: BrowserRecoveryDeps): BrowserRecoveryPorts {
  const listeners = new Set<() => void>();
  let identity: IdentityState = { kind: 'unavailable', retryable: true };
  let recovery: RecoveryCapabilities = PENDING;
  let closure: ClosureCapability | null = null;
  let revocationTargets: readonly RevocationCapability[] = [];
  let generation = 0;
  let disposed = false;
  let snapshot: RecoverySnapshot = build();

  function matchesOwner(state: IdentityState): boolean {
    return state.kind === 'signed_in' && state.principal.ownerId === deps.principal.ownerId
      && sameProviderIdentity(state.principal, deps.principal);
  }

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
      revocationTargets: matchesOwner(identity) ? revocationTargets : [],
      closure: matchesOwner(identity) ? closure : null,
    };
  }

  function publish(): void {
    if (disposed) return;
    snapshot = build();
    for (const listener of [...listeners]) listener();
  }

  async function ownerCurrent(): Promise<boolean> {
    if (disposed) return false;
    try {
      const state = await deps.identity.current();
      return !disposed && matchesOwner(state);
    } catch {
      return false;
    }
  }

  async function refresh(): Promise<void> {
    const own = ++generation;
    let nextIdentity: IdentityState;
    let nextRecovery: RecoveryCapabilities;
    let nextClosure: ClosureCapability | null = null;
    let nextTargets: readonly RevocationCapability[] = [];
    try {
      [nextIdentity, nextRecovery, nextClosure, nextTargets] = await Promise.all([
        deps.identity.current(), service.capabilities(), deps.closure?.currentCapability().catch(() => null) ?? Promise.resolve(null),
        Promise.resolve().then(() => deps.revocation?.targets() ?? []).catch(() => []),
      ]);
    } catch {
      nextIdentity = { kind: 'unavailable', retryable: true };
      nextRecovery = PENDING;
    }
    if (disposed || own !== generation) return;
    identity = nextIdentity;
    recovery = nextRecovery;
    revocationTargets = nextTargets;
    closure = nextClosure?.ownerId === deps.principal.ownerId ? nextClosure : null;
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
      if (!await ownerCurrent()) return rejected('forbidden');
      return deps.revocation.revoke(input, options);
    },
    async inspectRevocation(operationId, options) {
      if (!deps.revocation || disposed) return unavailable();
      if (!await ownerCurrent()) return rejected('not_found');
      return deps.revocation.inspect(operationId, options);
    },
    async closeRoom(input, options) {
      if (!deps.closure || disposed) return unavailable();
      if (!await ownerCurrent()
        || input.ownerId !== deps.principal.ownerId
        || closure?.roomId !== input.roomId || closure.expectedRoomRevision !== input.expectedRoomRevision) {
        return rejected('forbidden');
      }
      return deps.closure.closeRoom(input, options);
    },
    async inspectClosure(operationId, options) {
      if (!deps.closure || !await ownerCurrent()) return rejected('not_found');
      const result = await deps.closure.inspectClosure(operationId, options);
      if (result.kind === 'rejected') return rejected('not_found');
      if (result.kind === 'ok') return { kind: 'ok', value: result.value };
      if (result.kind === 'outcome_unknown') return result;
      return unavailable();
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
