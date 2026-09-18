// Browser composition lifecycle for the ordinary human flow. It exposes only
// verified contract ports to route composition and owns their route/device
// teardown ordering; UI modules never locate global services themselves.

import type {
  AdmissionPort,
  AuthPrincipal,
  ContentLimits,
  DevicePort,
  DeviceView,
  Disposer,
  IdentityPort,
  IdentityState,
  RoomPort,
} from '@khala/contracts/messaging/index';
import { createHumanDeviceSession } from './device-session';

export interface HumanApplicationPorts {
  readonly identity: IdentityPort;
  readonly device: DevicePort;
  readonly room: RoomPort;
  readonly admission: AdmissionPort;
  readonly limits: ContentLimits;
}

export interface HumanRouteContext extends HumanApplicationPorts {
  readonly path: string;
  readonly generation: number;
  readonly principal: AuthPrincipal;
  readonly deviceView: DeviceView & Readonly<{ state: 'ready'; deviceId: NonNullable<DeviceView['deviceId']> }>;
  /** Registers route/feature cleanup in this context's scoped lifetime. */
  registerDisposer(disposer: Disposer): Disposer;
}

type EmptySnapshot<Phase extends string> = Readonly<{
  phase: Phase;
  path: string;
  context: null;
}>;

export type HumanApplicationSnapshot =
  | EmptySnapshot<'checking_identity'>
  | EmptySnapshot<'initializing_device'>
  | EmptySnapshot<'signed_out'>
  | EmptySnapshot<'disposed'>
  | Readonly<{
      phase: 'unavailable';
      path: string;
      context: null;
      source: 'identity' | 'device' | 'route';
      reason: string;
      retryable: boolean;
    }>
  | Readonly<{
      phase: 'ready';
      path: string;
      context: HumanRouteContext;
    }>;

export interface HumanApplicationHandle {
  getSnapshot(): HumanApplicationSnapshot;
  subscribe(listener: () => void): Disposer;
  navigate(path: string): void;
  dispose(): void;
}

export type HumanApplicationOptions = Readonly<{
  initialPath?: string;
  createRouteDisposer?: (context: HumanRouteContext) => Disposer | void;
}>;

function identityUnavailable(): IdentityState {
  return { kind: 'unavailable', retryable: true };
}

export function createHumanApplication(
  ports: HumanApplicationPorts,
  options: HumanApplicationOptions = {},
): HumanApplicationHandle {
  let path = options.initialPath ?? '/';
  let epoch = 0;
  let disposed = false;
  let identityAbort: AbortController | null = null;
  let routeScope: Set<Disposer> | null = null;
  let snapshot: HumanApplicationSnapshot = { phase: 'checking_identity', path, context: null };
  const listeners = new Set<() => void>();
  const deviceSession = createHumanDeviceSession(ports.device);

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setSnapshot(next: HumanApplicationSnapshot): void {
    if (disposed) return;
    snapshot = next;
    notify();
  }

  function deactivateRoute(): void {
    const scope = routeScope;
    routeScope = null;
    if (!scope) return;
    for (const disposer of scope) {
      try {
        disposer();
      } catch {
        // Cleanup is best-effort, but one feature cannot keep later features or
        // the identity-scoped device alive by throwing from its disposer.
      }
    }
    scope.clear();
  }

  function unavailableSnapshot(
    activePath: string,
    source: 'identity' | 'device' | 'route',
    reason: string,
    retryable = true,
  ): HumanApplicationSnapshot {
    return { phase: 'unavailable', path: activePath, context: null, source, reason, retryable };
  }

  async function readIdentity(signal: AbortSignal): Promise<IdentityState> {
    try {
      return await ports.identity.current({ signal });
    } catch {
      return identityUnavailable();
    }
  }

  async function synchronize(activePath: string): Promise<void> {
    const generation = ++epoch;
    identityAbort?.abort();
    identityAbort = new AbortController();

    // Route-owned subscriptions and pending feature authority end as soon as a
    // navigation starts. The device stays leased until identity is known, so a
    // same-owner route change can reuse it without a second SDK/store.
    deactivateRoute();
    setSnapshot({ phase: 'checking_identity', path: activePath, context: null });

    const identity = await readIdentity(identityAbort.signal);
    if (disposed || generation !== epoch) return;

    if (identity.kind !== 'signed_in') {
      await deviceSession.release();
      if (disposed || generation !== epoch) return;
      setSnapshot(identity.kind === 'signed_out'
        ? { phase: 'signed_out', path: activePath, context: null }
        : unavailableSnapshot(activePath, 'identity', 'identity_unavailable'));
      return;
    }

    setSnapshot({ phase: 'initializing_device', path: activePath, context: null });
    const result = await deviceSession.ensureReady(identity.principal);
    if (disposed || generation !== epoch) return;

    if (result.kind !== 'ok') {
      const reason = result.kind === 'rejected'
        ? result.code
        : result.kind === 'outcome_unknown' ? 'device_outcome_unknown' : 'device_unavailable';
      setSnapshot(unavailableSnapshot(activePath, 'device', reason));
      return;
    }
    if (result.value.state !== 'ready' || result.value.deviceId === null) {
      setSnapshot(unavailableSnapshot(
        activePath,
        'device',
        result.value.reason ?? `device_${result.value.state}`,
        result.value.state !== 'revoked',
      ));
      return;
    }

    const scope = new Set<Disposer>();
    routeScope = scope;
    const context: HumanRouteContext = {
      ...ports,
      path: activePath,
      generation: result.value.generation,
      principal: identity.principal,
      deviceView: result.value as HumanRouteContext['deviceView'],
      registerDisposer(disposer) {
        if (routeScope !== scope) {
          try { disposer(); } catch { /* The route already ended. */ }
          return () => undefined;
        }
        scope.add(disposer);
        return () => {
          if (!scope.delete(disposer)) return;
          try { disposer(); } catch { /* Match aggregate cleanup semantics. */ }
        };
      },
    };

    try {
      const routeDisposer = options.createRouteDisposer?.(context);
      if (routeDisposer) context.registerDisposer(routeDisposer);
    } catch {
      deactivateRoute();
      setSnapshot(unavailableSnapshot(activePath, 'route', 'route_unavailable'));
      return;
    }
    if (disposed || generation !== epoch) {
      deactivateRoute();
      return;
    }
    setSnapshot({ phase: 'ready', path: activePath, context });
  }

  const removeDeviceListener = deviceSession.subscribe(view => {
    if (disposed || snapshot.phase !== 'ready' || view.state === 'ready') return;
    epoch += 1;
    identityAbort?.abort();
    deactivateRoute();
    setSnapshot(unavailableSnapshot(path, 'device', view.reason ?? `device_${view.state}`, view.state !== 'revoked'));
    void deviceSession.release();
  });

  const handle: HumanApplicationHandle = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    navigate(nextPath) {
      if (disposed) return;
      path = nextPath;
      void synchronize(path);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      identityAbort?.abort();
      identityAbort = null;
      deactivateRoute();
      snapshot = { phase: 'disposed', path, context: null };
      notify();
      listeners.clear();
      removeDeviceListener();
      void deviceSession.dispose();
    },
  };

  void synchronize(path);
  return handle;
}
