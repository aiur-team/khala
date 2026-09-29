// Route-agnostic application screen: shell chrome, identity/device status and
// the ready route. It imports no route feature, so a composition that never
// offers join, share or recovery never loads their code. `mount.tsx` binds the
// hosted routes; the internal entry binds its own.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Disposer } from '@khala/contracts/messaging/index';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import { resolveInitialTheme } from '../../shell/theme';
import type { ShellMode, ThemeChoice } from '../../shell/types';
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
  /** Renders one parsed route for a ready, identity-scoped context. */
  renderRoute: (context: HumanRouteContext, route: Route) => ReactNode;
  /** What a signed-out snapshot shows; a composition without sign-in renders its own terminal state. */
  renderSignedOut: (path: string) => ReactNode;
  /** Signed-in key loss stays outside every room route and owner-only capability. */
  renderDeviceLoss?: (path: string) => ReactNode;
  /** Attaches optional capabilities to each ready route context. */
  attachCapabilities?: (context: HumanRouteContext) => Disposer;
  /** Replaces the default shell around a ready route, e.g. with owner-only navigation. */
  renderReadyShell?: (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode) => ReactNode;
  /** Account action for signed-in device or route failures outside the ready shell. */
  renderSignedInAction?: (mode: ShellMode) => ReactNode;
}>;

/** Shell state the screen owns, so it survives a switch between the default and a ready shell. */
export type HumanShellChrome = Readonly<{
  path: string;
  mode: ShellMode;
  theme: Readonly<{ theme: ThemeChoice; onThemeChange(theme: ThemeChoice): void }>;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
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

function RouteLoading() {
  return <section className="khala-route-loading" role="status" aria-label="Loading conversation">
    <span /><span /><span />
  </section>;
}

function ReadyRoute<Route>({ context, routes, renderRoute, attachCapabilities }: {
  context: HumanRouteContext;
  routes: HumanScreenRoutes<Route>;
  renderRoute: HumanScreenProps<Route>['renderRoute'];
  attachCapabilities: HumanScreenProps<Route>['attachCapabilities'];
}) {
  useEffect(() => attachCapabilities?.(context), [attachCapabilities, context]);
  return <>{renderRoute(context, routes.parse(context.path))}</>;
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
  renderSignedInAction,
}: HumanScreenProps<Route>) {
  const snapshot = useSyncExternalStore(application.subscribe, application.getSnapshot, application.getSnapshot);
  const [theme, setTheme] = useState<ThemeChoice>(() => resolveInitialTheme(
    typeof localStorage === 'undefined' ? {} : { storage: localStorage },
  ));
  const [collapsed, setCollapsed] = useState(false);

  let content: ReactNode;
  if (snapshot.phase === 'ready') {
    content = (
      <ReadyRoute context={snapshot.context} routes={routes} renderRoute={renderRoute} attachCapabilities={attachCapabilities} />
    );
  } else if (snapshot.phase === 'navigating') {
    content = <RouteLoading />;
  } else if (snapshot.phase === 'signed_out') {
    content = renderSignedOut(snapshot.path);
  } else if (snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source === 'device'
    && snapshot.reason === 'lease_unavailable') {
    content = <InactiveDevice application={application} timedOut={snapshot.phase === 'unavailable'} />;
  } else if (snapshot.phase === 'unavailable' && snapshot.source === 'device'
    && (snapshot.reason === 'storage_cleared' || snapshot.reason === 'key_material_missing')
    && renderDeviceLoss !== undefined) {
    content = renderDeviceLoss(snapshot.path);
  } else {
    content = (
      <KhalaPageFrame model={{ title: 'Account and device status', labelledBy: 'khala-status' }}>
        <Panel>{statusContent(snapshot)}</Panel>
      </KhalaPageFrame>
    );
  }

  const chrome: HumanShellChrome = {
    path: snapshot.path,
    mode,
    theme: { theme, onThemeChange: setTheme },
    collapsed,
    onCollapsedChange: setCollapsed,
  };
  if ((snapshot.phase === 'ready' || snapshot.phase === 'navigating') && renderReadyShell !== undefined) {
    return <>{renderReadyShell(snapshot.context, chrome, content)}</>;
  }
  const signedInAction = snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source !== 'identity'
    ? renderSignedInAction?.(mode) : null;
  const inactiveShell = snapshot.phase === 'inactive' || snapshot.phase === 'unavailable' && snapshot.source === 'device'
    && snapshot.reason === 'lease_unavailable';
  return (
    <AiurShell
      mode={mode}
      brandHref={inactiveShell ? snapshot.path : routes.createPath()}
      navigation={[]}
      sidebar={inactiveShell ? <div className="khala-sidebar"><p className="khala-sidebar__inactive">Channels are paused in this tab.</p></div> : undefined}
      actions={signedInAction}
      theme={chrome.theme}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    >
      {mode === 'hosted-content' && signedInAction ? <div className="khala-content-actions">{signedInAction}</div> : null}
      {content}
    </AiurShell>
  );
}
