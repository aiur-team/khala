import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import { resolveInitialTheme } from '../../shell/theme';
import type { ShellMode, ThemeChoice } from '../../shell/types';
import { ChannelRequestsInbox } from '../../features/channel-access/ChannelRequestsInbox';
import { ChannelRequestsNavEntry } from '../../features/channel-access/ChannelRequestsNavEntry';
import type { ChannelAccessInboxController } from '../../features/channel-access/controller';
import { CreateChannelScreen } from '../../features/create-channel/CreateChannelScreen';
import { createJoinController } from '../../features/join/controller';
import { JoinScreen } from '../../features/join/JoinScreen';
import type { JoinView } from '../../features/join/model';
import type { HumanApplicationHandle, HumanRouteContext } from './application';
import { attachHumanCapabilities, registerHumanCapabilities, type HumanCapability } from './capabilities';
import type { HumanRoute, HumanRouteCodec } from './routes';

export type HumanRoomRenderer = (context: HumanRouteContext, route: Extract<HumanRoute, { kind: 'channel' }>) => ReactNode;

export type HumanApplicationScreenProps = Readonly<{
  application: HumanApplicationHandle;
  identity: IdentityPort;
  routes: HumanRouteCodec;
  mode?: ShellMode;
  navigateExternal?: (url: string) => void;
  navigateRoute?: (path: string) => void;
  /** Binds the live room screens; production supplies `renderHumanRoom`. */
  renderRoom: HumanRoomRenderer;
  channelAccess: ChannelAccessInboxController;
  capabilities?: readonly HumanCapability[];
}>;

export type MountKhalaContentOptions = HumanApplicationScreenProps & Readonly<{ target: Element }>;

export type KhalaContentHandle = Readonly<{ dispose(): void }>;

function statusContent(snapshot: ReturnType<HumanApplicationHandle['getSnapshot']>): ReactNode {
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

function JoinRoute({ context, routes, navigateExternal, navigateRoute }: {
  context: HumanRouteContext;
  routes: HumanRouteCodec;
  navigateExternal: (url: string) => void;
  navigateRoute: (path: string) => void;
}) {
  const controller = useMemo(() => createJoinController({
    identity: context.identity,
    device: context.device,
    admission: context.admission,
    codec: routes,
    navigate: navigateExternal,
  }), [context, navigateExternal, routes]);
  const [view, setView] = useState<JoinView>(() => controller.getView());

  useEffect(() => controller.subscribe(setView), [controller]);
  useEffect(() => {
    controller.start(context.path);
  }, [context.path, controller]);

  return (
    <JoinScreen
      view={view}
      onSignIn={() => void controller.signIn()}
      onRetry={() => controller.retry()}
      onOpenRoom={roomId => navigateRoute(routes.roomPath(roomId))}
    />
  );
}

function ReadyRoute({ context, routes, renderRoom, navigateExternal, navigateRoute, capabilities, channelAccess }: {
  context: HumanRouteContext;
  routes: HumanRouteCodec;
  renderRoom: HumanRoomRenderer;
  navigateExternal: (url: string) => void;
  navigateRoute: (path: string) => void;
  capabilities: readonly HumanCapability[];
  channelAccess: ChannelAccessInboxController;
}) {
  useEffect(() => attachHumanCapabilities(capabilities, context), [capabilities, context]);
  const route = routes.parse(context.path);
  switch (route.kind) {
    case 'create':
      return (
        <KhalaPageFrame model={{ title: 'Khala', description: 'Create a private channel and share its link.', labelledBy: 'khala-create-title' }}>
          <CreateChannelScreen ports={context} onOpenRoom={roomId => navigateRoute(routes.roomPath(roomId))} />
        </KhalaPageFrame>
      );
    case 'join':
      return <JoinRoute context={context} routes={routes} navigateExternal={navigateExternal} navigateRoute={navigateRoute} />;
    case 'channel':
      return renderRoom(context, route);
    case 'channel_requests':
      return (
        <KhalaPageFrame model={{ title: 'Channel requests', labelledBy: 'khala-channel-requests-title' }}>
          <ChannelRequestsInbox controller={channelAccess} selectedHandle={route.selectedHandle} />
        </KhalaPageFrame>
      );
    case 'not_found':
      return (
        <KhalaPageFrame model={{ title: 'Page not found', labelledBy: 'khala-not-found' }}>
          <p role="alert">This Khala link is not valid.</p>
        </KhalaPageFrame>
      );
  }
}

function OwnerShell({ controller, routes, path, mode, theme, collapsed, onCollapsedChange, children }: {
  controller: ChannelAccessInboxController;
  routes: HumanRouteCodec;
  path: string;
  mode: ShellMode;
  theme: Readonly<{ theme: ThemeChoice; onThemeChange(theme: ThemeChoice): void }>;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  children: ReactNode;
}) {
  const route = routes.parse(path);
  return (
    <AiurShell
      mode={mode}
      navigation={[
        { id: 'khala', label: 'Khala', href: routes.createPath(), current: route.kind !== 'channel_requests' },
        {
          id: 'channel-requests',
          label: 'Channel requests',
          href: routes.channelRequestsPath(),
          current: route.kind === 'channel_requests',
          content: (
            <ChannelRequestsNavEntry
              controller={controller}
              href={routes.channelRequestsPath()}
              current={route.kind === 'channel_requests'}
            />
          ),
        },
      ]}
      theme={theme}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    >
      {children}
    </AiurShell>
  );
}

export function HumanApplicationScreen({
  application,
  identity,
  routes,
  mode = 'hosted-content',
  navigateExternal = url => globalThis.location?.assign(url),
  navigateRoute = path => application.navigate(path),
  renderRoom,
  channelAccess,
  capabilities = registerHumanCapabilities(),
}: HumanApplicationScreenProps) {
  const snapshot = useSyncExternalStore(application.subscribe, application.getSnapshot, application.getSnapshot);
  const [theme, setTheme] = useState<ThemeChoice>(() => resolveInitialTheme(
    typeof localStorage === 'undefined' ? {} : { storage: localStorage },
  ));
  const [collapsed, setCollapsed] = useState(false);
  const [signInFailed, setSignInFailed] = useState(false);

  useEffect(() => {
    if (snapshot.phase === 'ready') channelAccess.start();
  }, [channelAccess, snapshot.phase]);
  useEffect(() => () => channelAccess.dispose(), [channelAccess]);

  async function signIn() {
    setSignInFailed(false);
    const result = await identity.beginSignIn(snapshot.path);
    if (result.kind === 'ok') navigateExternal(result.value.url);
    else setSignInFailed(true);
  }

  let content: ReactNode;
  if (snapshot.phase === 'ready') {
    content = (
      <ReadyRoute
        context={snapshot.context}
        routes={routes}
        navigateExternal={navigateExternal}
        navigateRoute={navigateRoute}
        capabilities={capabilities}
        renderRoom={renderRoom}
        channelAccess={channelAccess}
      />
    );
  } else if (snapshot.phase === 'signed_out') {
    content = (
      <KhalaPageFrame model={{ title: 'Sign in to Khala', labelledBy: 'khala-sign-in' }}>
        <Panel heading="Continue with your account">
          <button type="button" onClick={() => void signIn()}>Sign in</button>
          {signInFailed ? <p role="alert">Sign-in is unavailable right now.</p> : null}
        </Panel>
      </KhalaPageFrame>
    );
  } else {
    content = (
      <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-status' }}>
        <Panel heading="Account and device status">{statusContent(snapshot)}</Panel>
      </KhalaPageFrame>
    );
  }

  // The human application's ready state is the credential guard. Removing it
  // would expose owner-only inbox chrome on agent/discovery credential routes.
  const ownerChannelAccess = snapshot.phase === 'ready' ? channelAccess : null;
  if (ownerChannelAccess !== null) {
    return (
      <OwnerShell
        controller={ownerChannelAccess}
        routes={routes}
        path={snapshot.path}
        mode={mode}
        theme={{ theme, onThemeChange: setTheme }}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      >
        {content}
      </OwnerShell>
    );
  }
  return (
    <AiurShell
      mode={mode}
      navigation={mode === 'standalone' ? [{ id: 'khala', label: 'Khala', href: routes.createPath(), current: true }] : []}
      theme={{ theme, onThemeChange: setTheme }}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    >
      {content}
    </AiurShell>
  );
}

export function mountKhalaContent(options: MountKhalaContentOptions): KhalaContentHandle {
  const root: Root = createRoot(options.target);
  root.render(<HumanApplicationScreen {...options} />);
  return { dispose: () => root.unmount() };
}
