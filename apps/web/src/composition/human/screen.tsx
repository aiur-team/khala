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
  /** Attaches optional capabilities to each ready route context. */
  attachCapabilities?: (context: HumanRouteContext) => Disposer;
  /** Replaces the default shell around a ready route, e.g. with owner-only navigation. */
  renderReadyShell?: (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode) => ReactNode;
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
  attachCapabilities,
  renderReadyShell,
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
  } else if (snapshot.phase === 'signed_out') {
    content = renderSignedOut(snapshot.path);
  } else {
    content = (
      <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-status' }}>
        <Panel heading="Account and device status">{statusContent(snapshot)}</Panel>
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
  if (snapshot.phase === 'ready' && renderReadyShell !== undefined) {
    return <>{renderReadyShell(snapshot.context, chrome, content)}</>;
  }
  return (
    <AiurShell
      mode={mode}
      navigation={mode === 'standalone' ? [{ id: 'khala', label: 'Khala', href: routes.createPath(), current: true }] : []}
      theme={chrome.theme}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    >
      {content}
    </AiurShell>
  );
}
