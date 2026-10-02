// Route-agnostic application screen: shell chrome, identity/device status and
// the ready route. It imports no route feature, so a composition that never
// offers join, share or recovery never loads their code. `mount.tsx` binds the
// hosted routes; the internal entry binds its own.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Disposer } from '@khala/contracts/messaging/index';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import { LoadingSpinner } from '../../ui/khala/LoadingSpinner';
import { persistTheme, resolveInitialTheme } from '../../shell/theme';
import type { ShellMode, ThemeChoice } from '../../shell/types';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from './application';

export type HumanScreenRoutes<Route> = Readonly<{
  parse(location: string): Route;
  /** Target of the standalone navigation entry. */
  createPath(): string;
}>;

export type HumanScreenProps<Route> = Readonly<{
  application: HumanApplicationHandle;
  routes: HumanScreenRoutes<Route>;
  mode?: ShellMode;
  /** Renders one parsed route for a ready, identity-scoped context; a route that draws its own page uses `chrome`. */
  renderRoute: (context: HumanRouteContext, route: Route, chrome: HumanShellChrome) => ReactNode;
  /** What a signed-out snapshot shows; a composition without sign-in renders its own terminal state. */
  renderSignedOut: (path: string) => ReactNode;
  /** Signed-in key loss stays outside every room route and owner-only capability. */
  renderDeviceLoss?: (path: string) => ReactNode;
  /** Attaches optional capabilities to each ready route context. */
  attachCapabilities?: (context: HumanRouteContext) => Disposer;
  /** Replaces the default shell around a ready route, e.g. with owner-only navigation. */
  renderReadyShell?: (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode, phase: 'ready' | 'navigating') => ReactNode;
  /** Neutral shell while identity is checked or the signed-in device is unavailable. */
  renderPendingShell?: (chrome: HumanShellChrome, phase: 'checking_identity' | 'initializing_device' | 'inactive' | 'unavailable', children: ReactNode) => ReactNode;
  /** Account action for signed-in device or route failures outside the ready shell. */
  renderSignedInAction?: (mode: ShellMode) => ReactNode;
}>;

/** Shell state the screen owns, so it survives a switch between the default and a ready shell. */
export type HumanShellChrome = Readonly<{
  path: string;
  mode: ShellMode;
  theme: Readonly<{ theme: ThemeChoice; onThemeChange(theme: ThemeChoice): void }>;
}>;

function statusContent(snapshot: HumanApplicationSnapshot): ReactNode {
  switch (snapshot.phase) {
    case 'checking_identity':
      return <p role="status">Checking your sign-in…</p>;
    case 'initializing_device':
      return <p role="status">Getting this device ready…</p>;
    case 'unavailable':
      return <p role="alert">Khala is unavailable right now ({snapshot.reason}).</p>;
    case 'disposed':
      return <p role="status">Khala has closed.</p>;
    default:
      return null;
  }
}

function InactiveDevice({ application, timedOut }: { application: HumanApplicationHandle; timedOut: boolean }) {
  return <section className="khala-inactive-device" aria-label="Inactive tab">
    <Panel heading={timedOut ? 'Device handoff took too long' : 'Khala is active in another tab'}>
      <p>{timedOut ? 'The other tab has not released this device yet. Focus this tab and try again.'
        : 'Your channels will resume here when you focus this tab.'}</p>
      <button type="button" className="aiur-action" onClick={() => application.retryDevice()}>Try again in this tab</button>
    </Panel>
  </section>;
}

function ReadyRoute<Route>({ context, chrome, routes, renderRoute, attachCapabilities }: {
  context: HumanRouteContext;
  chrome: HumanShellChrome;
  routes: HumanScreenRoutes<Route>;
  renderRoute: HumanScreenProps<Route>['renderRoute'];
  attachCapabilities: HumanScreenProps<Route>['attachCapabilities'];
}) {
  useEffect(() => attachCapabilities?.(context), [attachCapabilities, context]);
  return <>{renderRoute(context, routes.parse(context.path), chrome)}</>;
}

export function HumanScreen<Route>({
  application,
  routes,
  mode = 'hosted-content',
  renderRoute,
  renderSignedOut,
  renderDeviceLoss,
  attachCapabilities,
  renderReadyShell,
  renderPendingShell,
  renderSignedInAction,
}: HumanScreenProps<Route>) {
  const snapshot = useSyncExternalStore(application.subscribe, application.getSnapshot, application.getSnapshot);
  const [theme, setChosenTheme] = useState<ThemeChoice>(() => resolveInitialTheme(
    typeof localStorage === 'undefined' ? {} : { storage: localStorage },
  ));
  // A toggled theme is remembered for the next visit.
  const setTheme = (next: ThemeChoice) => {
    setChosenTheme(next);
    if (typeof localStorage !== 'undefined') persistTheme(next, localStorage);
  };

  const chrome: HumanShellChrome = {
    path: snapshot.path,
    mode,
    theme: { theme, onThemeChange: setTheme },
  };
  let content: ReactNode;
  if (snapshot.phase === 'ready') {
    content = (
      <ReadyRoute context={snapshot.context} chrome={chrome} routes={routes} renderRoute={renderRoute} attachCapabilities={attachCapabilities} />
    );
  } else if (snapshot.phase === 'navigating') {
    content = <LoadingSpinner />;
  } else if (snapshot.phase === 'signed_out') {
    content = renderSignedOut(snapshot.path);
  } else if (snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source === 'device'
    && snapshot.reason === 'lease_unavailable') {
    content = <InactiveDevice application={application} timedOut={snapshot.phase === 'unavailable'} />;
  } else if (snapshot.phase === 'unavailable' && snapshot.source === 'device'
    && (snapshot.reason === 'storage_cleared' || snapshot.reason === 'key_material_missing'
      || snapshot.reason === 'recovery_required')
    && renderDeviceLoss !== undefined) {
    content = renderDeviceLoss(snapshot.path);
  } else if ((snapshot.phase === 'checking_identity' || snapshot.phase === 'initializing_device'
    || (snapshot.phase === 'unavailable' && snapshot.source !== 'identity')) && renderPendingShell) {
    content = <section className="khala-device-status" aria-label="Channel status">{statusContent(snapshot)}
      {snapshot.phase === 'unavailable' && snapshot.retryable
        ? <button type="button" className="aiur-action" onClick={() => application.navigate(snapshot.path)}>Try again</button>
        : null}
    </section>;
  } else {
    content = (
      <KhalaPageFrame model={{ title: 'Account and device status', labelledBy: 'khala-status' }}>
        <Panel>{statusContent(snapshot)}</Panel>
      </KhalaPageFrame>
    );
  }

  if ((snapshot.phase === 'ready' || snapshot.phase === 'navigating') && renderReadyShell !== undefined) {
    return <>{renderReadyShell(snapshot.context, chrome, content, snapshot.phase)}</>;
  }
  if ((snapshot.phase === 'checking_identity' || snapshot.phase === 'initializing_device'
    || snapshot.phase === 'inactive'
    || (snapshot.phase === 'unavailable' && snapshot.source !== 'identity')) && renderPendingShell) {
    return <>{renderPendingShell(chrome, snapshot.phase, content)}</>;
  }
  const signedInAction = snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source !== 'identity'
    ? renderSignedInAction?.(mode) : null;
  const inactiveShell = snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source === 'device'
    && snapshot.reason === 'lease_unavailable';
  return (
    <KhalaApp
      theme={theme}
      onThemeChange={setTheme}
      homeHref={inactiveShell ? snapshot.path : routes.createPath()}
      brandActions={signedInAction}
      {...(inactiveShell ? { list: <p className="kh-cv-empty">Channels are paused in this tab.</p> } : {})}
      main={<div className="kh-state">{content}</div>}
    />
  );
}
