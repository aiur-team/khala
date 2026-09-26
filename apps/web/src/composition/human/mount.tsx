import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChannelAccessRequestHandle, IdentityPort } from '@khala/contracts/messaging/index';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import type { ShellMode } from '../../shell/types';
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
import { HumanScreen, type HumanShellChrome } from './screen';

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
  createChannelAccess: () => ChannelAccessInboxController;
  capabilities?: readonly HumanCapability[];
}>;

export type MountKhalaContentOptions = HumanApplicationScreenProps & Readonly<{ target: Element }>;

export type KhalaContentHandle = Readonly<{ dispose(): void }>;

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

function SignInPanel({ identity, path, navigateExternal }: {
  identity: IdentityPort;
  path: string;
  navigateExternal: (url: string) => void;
}) {
  const [signInFailed, setSignInFailed] = useState(false);

  async function signIn() {
    setSignInFailed(false);
    const result = await identity.beginSignIn(path);
    if (result.kind === 'ok') navigateExternal(result.value.url);
    else setSignInFailed(true);
  }

  return (
    <KhalaPageFrame model={{ title: 'Sign in to Khala', labelledBy: 'khala-sign-in' }}>
      <Panel heading="Continue with your account">
        <button type="button" onClick={() => void signIn()}>Sign in</button>
        {signInFailed ? <p role="alert">Sign-in is unavailable right now.</p> : null}
      </Panel>
    </KhalaPageFrame>
  );
}

const ChannelAccessContext = createContext<ChannelAccessInboxController | null>(null);

function ChannelRequestsRoute({ selectedHandle }: { selectedHandle: ChannelAccessRequestHandle | null }) {
  const controller = useContext(ChannelAccessContext);
  return (
    <KhalaPageFrame model={{ title: 'Channel requests', labelledBy: 'khala-channel-requests-title' }}>
      {controller === null ? null : <ChannelRequestsInbox controller={controller} selectedHandle={selectedHandle} />}
    </KhalaPageFrame>
  );
}

function OwnerShell({ createController, routes, chrome, children }: {
  createController: () => ChannelAccessInboxController;
  routes: HumanRouteCodec;
  chrome: HumanShellChrome;
  children: ReactNode;
}) {
  const [controller] = useState(createController);
  const route = routes.parse(chrome.path);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  return (
    <AiurShell
      mode={chrome.mode}
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
      theme={chrome.theme}
      collapsed={chrome.collapsed}
      onCollapsedChange={chrome.onCollapsedChange}
    >
      <ChannelAccessContext.Provider value={controller}>{children}</ChannelAccessContext.Provider>
    </AiurShell>
  );
}

/** The hosted human application: create, join and channel routes behind OAuth sign-in. */
export function HumanApplicationScreen({
  application,
  identity,
  routes,
  mode = 'hosted-content',
  navigateExternal = url => globalThis.location?.assign(url),
  navigateRoute = path => application.navigate(path),
  renderRoom,
  createChannelAccess,
  capabilities = registerHumanCapabilities(),
}: HumanApplicationScreenProps) {
  const renderRoute = (context: HumanRouteContext, route: HumanRoute): ReactNode => {
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
        return <ChannelRequestsRoute selectedHandle={route.selectedHandle} />;
      case 'not_found':
        return (
          <KhalaPageFrame model={{ title: 'Page not found', labelledBy: 'khala-not-found' }}>
            <p role="alert">This Khala link is not valid.</p>
          </KhalaPageFrame>
        );
    }
  };
  const attachCapabilities = useCallback(
    (context: HumanRouteContext) => attachHumanCapabilities(capabilities, context),
    [capabilities],
  );
  // The human application's ready state is the credential guard: the owner
  // shell renders only for a ready snapshot, so agent/discovery credential
  // routes never see owner-only inbox chrome.
  const renderReadyShell = (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode) => (
    <OwnerShell key={context.principal.ownerId} createController={createChannelAccess} routes={routes} chrome={chrome}>
      {children}
    </OwnerShell>
  );

  return (
    <HumanScreen
      application={application}
      routes={routes}
      mode={mode}
      renderRoute={renderRoute}
      renderSignedOut={path => <SignInPanel identity={identity} path={path} navigateExternal={navigateExternal} />}
      attachCapabilities={attachCapabilities}
      renderReadyShell={renderReadyShell}
    />
  );
}

export function mountKhalaContent(options: MountKhalaContentOptions): KhalaContentHandle {
  const root: Root = createRoot(options.target);
  root.render(<HumanApplicationScreen {...options} />);
  return { dispose: () => root.unmount() };
}
