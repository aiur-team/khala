// Browser composition lifecycle for the ordinary human flow. It exposes only
// verified contract ports to route composition and owns their route/device
// teardown ordering; UI modules never locate global services themselves.

import { unavailable } from '@khala/contracts/messaging/index';
import type {
  AdmissionPort,
  AuthPrincipal,
  ContentLimits,
  DevicePort,
  DeviceView,
  Disposer,
  IdentityPort,
  IdentityState,
  OperationResult,
  ParticipantView,
  RoomPort,
  RoomId,
  ClosureCapability,
  ClosurePort,
  RevocationPort,
  RevocationSubject,
} from '@khala/contracts/messaging/index';
import type { ChannelService } from '@khala/messaging/channels/index';
import type { ConversationIndexPort } from './conversations';

type ChannelClosureContext = Pick<ClosurePort, 'closeRoom' | 'inspectClosure'> & Readonly<{
  currentCapability(): Promise<ClosureCapability | null>;
}>;
import { createHumanDeviceSession } from './device-session';
import type { TabHandoff } from './tab-handoff';

export interface HumanApplicationPorts {
  readonly identity: IdentityPort;
  readonly device: DevicePort;
  readonly room: RoomPort & Partial<Pick<ChannelService, 'observeEntries'>>;
  readonly conversations?: ConversationIndexPort;
  readonly admission: AdmissionPort;
  readonly limits: ContentLimits;
  /** Authenticated participant mapping supplied by the live messaging adapter. */
  readonly participant?: () => ParticipantView | null;
  readonly closure?: (roomId: RoomId) => ChannelClosureContext;
  readonly revocation?: (roomId: RoomId) => RevocationPort & Readonly<{
    targets(): Readonly<Pick<AuthPrincipal, 'ownerId' | 'providerIssuer' | 'providerSubject'> & {
      targets: readonly (RevocationSubject & Readonly<{ expectedGeneration: number }>)[];
    }> | null | Promise<Readonly<Pick<AuthPrincipal, 'ownerId' | 'providerIssuer' | 'providerSubject'> & {
      targets: readonly (RevocationSubject & Readonly<{ expectedGeneration: number }>)[];
    }> | null>;
  }>;
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
  | EmptySnapshot<'inactive'>
  | Readonly<{ phase: 'navigating'; path: string; context: HumanRouteContext }>
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
  signOut(): Promise<OperationResult<null, never>>;
  retryDevice(): void;
  dispose(): void;
}

export type HumanApplicationOptions = Readonly<{
  initialPath?: string;
  createRouteDisposer?: (context: HumanRouteContext) => Disposer | void;
  tabHandoff?: TabHandoff;
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
  let signOutPending: Promise<OperationResult<null, never>> | null = null;
  let signOutOperationId: string | null = null;
  let snapshot: HumanApplicationSnapshot = { phase: 'checking_identity', path, context: null };
  const listeners = new Set<() => void>();
  const deviceSession = createHumanDeviceSession(ports.device);
  let signedInOwner: AuthPrincipal['ownerId'] | null = null;

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
    const previous = snapshot.phase === 'ready' || snapshot.phase === 'navigating' ? snapshot.context : null;
    deactivateRoute();
    setSnapshot(previous ? { phase: 'navigating', path: activePath, context: previous }
      : { phase: 'checking_identity', path: activePath, context: null });

    const identity = await readIdentity(identityAbort.signal);
    if (disposed || generation !== epoch) return;

    if (identity.kind !== 'signed_in') {
      signedInOwner = null;
      await deviceSession.release();
      if (disposed || generation !== epoch) return;
      setSnapshot(identity.kind === 'signed_out'
        ? { phase: 'signed_out', path: activePath, context: null }
        : unavailableSnapshot(activePath, 'identity', 'identity_unavailable'));
      return;
    }

    signedInOwner = identity.principal.ownerId;
    if (options.tabHandoff && !options.tabHandoff.isFocused() && deviceSession.current()?.state !== 'ready') {
      setSnapshot({ phase: 'inactive', path: activePath, context: null });
      return;
    }

    if (!previous) setSnapshot({ phase: 'initializing_device', path: activePath, context: null });
    const handoff = options.tabHandoff;
    let requestTimer: ReturnType<typeof setInterval> | null = null;
    if (handoff && deviceSession.current()?.state !== 'ready') {
      handoff.request(identity.principal.ownerId);
      // A claim can arrive before the previous tab's blur settles. Repeat only
      // while this tab remains focused and activation is still pending.
      requestTimer = setInterval(() => {
        if (!disposed && generation === epoch && handoff.isFocused()) handoff.request(identity.principal.ownerId);
      }, 500);
    }
    const result = await deviceSession.ensureReady(identity.principal).finally(() => {
      if (requestTimer) clearInterval(requestTimer);
    });
    if (disposed || generation !== epoch) return;
    if (handoff && !handoff.isFocused()) {
      setSnapshot({ phase: 'inactive', path: activePath, context: null });
      await deviceSession.release();
      return;
    }

    if (result.kind !== 'ok') {
      const latest = deviceSession.current();
      const reason = result.kind === 'rejected'
        ? result.code
        : latest?.state === 'failed' && latest.reason ? latest.reason
          : result.kind === 'outcome_unknown' ? 'device_outcome_unknown' : 'device_unavailable';
      setSnapshot(unavailableSnapshot(activePath, 'device', reason));
      return;
    }
    // Reconcile with an observer notification that may have arrived after the
    // activation promise settled but before this continuation ran. Otherwise a
    // revocation in that window would be overwritten by the stale ready value.
    const deviceView = deviceSession.current() ?? result.value;
    if (deviceView.state !== 'ready' || deviceView.deviceId === null) {
      setSnapshot(unavailableSnapshot(
        activePath,
        'device',
        deviceView.reason ?? `device_${deviceView.state}`,
        deviceView.state !== 'revoked',
      ));
      return;
    }

    const scope = new Set<Disposer>();
    routeScope = scope;
    const context: HumanRouteContext = {
      ...ports,
      path: activePath,
      generation: deviceView.generation,
      principal: identity.principal,
      deviceView: deviceView as HumanRouteContext['deviceView'],
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
    if (disposed || (snapshot.phase !== 'ready' && snapshot.phase !== 'navigating') || view.state === 'ready') return;
    epoch += 1;
    identityAbort?.abort();
    deactivateRoute();
    setSnapshot(unavailableSnapshot(path, 'device', view.reason ?? `device_${view.state}`, view.state !== 'revoked'));
    void deviceSession.release();
  });

  const removeTabHandoff = options.tabHandoff?.listen(ownerId => {
    if (disposed || ownerId !== signedInOwner || options.tabHandoff?.isFocused() || snapshot.phase === 'signed_out'
      || snapshot.phase === 'inactive' || snapshot.phase === 'disposed'
      || snapshot.phase === 'unavailable' && snapshot.source === 'device'
        && snapshot.reason !== 'lease_unavailable') return;
    // Remove route authority before stop publishes its transient device view.
    epoch += 1;
    identityAbort?.abort();
    deactivateRoute();
    setSnapshot({ phase: 'inactive', path, context: null });
    void deviceSession.release();
  }, () => {
    if (disposed) return;
    if (snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source === 'device'
      && snapshot.reason === 'lease_unavailable') void synchronize(path);
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

    retryDevice() {
      if (disposed || snapshot.phase !== 'inactive' && (snapshot.phase !== 'unavailable' || snapshot.source !== 'device'
        || snapshot.reason !== 'lease_unavailable')) return;
      void synchronize(path);
    },

    signOut() {
      if (disposed) return Promise.resolve(unavailable());
      if (signOutPending) return signOutPending;
      const operationId = signOutOperationId ?? `logout_${crypto.randomUUID()}`;
      signOutOperationId = operationId;
      const pending = (async (): Promise<OperationResult<null, never>> => {
        let result: OperationResult<null, never>;
        try {
          result = await ports.identity.signOut(operationId);
        } catch {
          result = unavailable();
        }
        if (result.kind === 'ok' && !disposed) {
          epoch += 1;
          identityAbort?.abort();
          deactivateRoute();
          path = '/new';
          signedInOwner = null;
          setSnapshot({ phase: 'checking_identity', path, context: null });
          await deviceSession.release();
          setSnapshot({ phase: 'signed_out', path, context: null });
          signOutOperationId = null;
        }
        return result;
      })();
      signOutPending = pending;
      void pending.finally(() => { if (signOutPending === pending) signOutPending = null; });
      return pending;
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
      removeTabHandoff?.();
      void deviceSession.dispose();
    },
  };

  void synchronize(path);
  return handle;
}
