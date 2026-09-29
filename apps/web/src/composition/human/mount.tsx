import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { AgentJoinGuidance, JoinScreen } from '../../features/join/JoinScreen';
import type { JoinView } from '../../features/join/model';
import type { HumanApplicationHandle, HumanRouteContext } from './application';
import { attachHumanCapabilities, registerHumanCapabilities, type HumanCapability } from './capabilities';
import type { HumanRoute, HumanRouteCodec } from './routes';
import { HumanScreen, type HumanShellChrome } from './screen';
import { ConversationIndexRoute } from './ConversationIndexRoute';

export type HumanRoomRenderer = (context: HumanRouteContext, route: Extract<HumanRoute, { kind: 'channel' }>, navigate?: (path: string) => void, routes?: HumanRouteCodec) => ReactNode;

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

function SignInPanel({ identity, path, isJoin, navigateExternal }: {
  identity: IdentityPort;
  path: string;
  isJoin: boolean;
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
      <Panel>
        <button type="button" className="aiur-action" onClick={() => void signIn()}>Sign in</button>
        {isJoin ? <><p>Humans: sign in to accept this invitation.</p><AgentJoinGuidance /></> : null}
        {signInFailed ? <p role="alert">Sign-in is unavailable right now.</p> : null}
      </Panel>
    </KhalaPageFrame>
  );
}

function LostDevicePanel() {
  return (
    <KhalaPageFrame model={{ title: 'Device keys unavailable', labelledBy: 'khala-device-loss' }}>
      <Panel>
        <p role="alert">Khala cannot open this device's encrypted messages or channels with the keys available here.</p>
        <p>If you still have a device or browser profile with its original keys, open Khala there to read its history. This browser profile cannot regain keys by retrying this page.</p>
        <p>If every device's keys are gone, earlier history cannot be recovered. Access from a new device requires a fresh authorized admission; this screen cannot grant one.</p>
      </Panel>
    </KhalaPageFrame>
  );
}

const ChannelAccessContext = createContext<ChannelAccessInboxController | null>(null);

function ChannelRequestsRoute({ selectedHandle }: { selectedHandle: ChannelAccessRequestHandle | null }) {
  const controller = useContext(ChannelAccessContext);
  return (
    <KhalaPageFrame model={{ title: 'Channel requests', labelledBy: 'khala-channel-requests-title' }}>
      {controller === null ? null : <ChannelRequestsInbox controller={controller} selectedHandle={selectedHandle} embedded />}
    </KhalaPageFrame>
  );
}

function LogoutAction({ application, routes, mode }: {
  application: HumanApplicationHandle;
  routes: HumanRouteCodec;
  mode: ShellMode;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const signOutInFlight = useRef(false);

  async function signOut() {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      const result = await application.signOut();
      if (result.kind !== 'ok') setSignOutFailed(true);
      else if (mode === 'standalone') globalThis.history?.replaceState(null, '', routes.createPath());
    } finally {
      signOutInFlight.current = false;
      setSigningOut(false);
    }
  }

  return <>
    {signOutFailed ? <span role="alert">Log out failed. Try again.</span> : null}
    {signingOut ? <span role="status">Logging out…</span> : null}
    <button type="button" className="aiur-shell__icon-button" aria-label="Log out" title="Log out"
      disabled={signingOut} onClick={() => void signOut()}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 17l5-5-5-5M15 12H3" />
        <path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" />
      </svg>
    </button>
  </>;
}

function OwnerShell({ application, createController, routes, chrome, children }: {
  application: HumanApplicationHandle;
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
  const actions = <LogoutAction application={application} routes={routes} mode={chrome.mode} />;
  return (
    <AiurShell
      mode={chrome.mode}
      navigation={[
        { id: 'khala', label: 'Conversations', href: routes.conversationsPath(), current: route.kind === 'conversations' || route.kind === 'channel' },
        { id: 'new-channel', label: 'New channel', href: routes.createPath(), current: route.kind === 'create' },
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
      brandHref={routes.createPath()}
      actions={actions}
      theme={chrome.theme}
      collapsed={chrome.collapsed}
      onCollapsedChange={chrome.onCollapsedChange}
    >
      {chrome.mode === 'hosted-content' ? <div className="khala-content-actions">{actions}</div> : null}
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
      case 'conversations':
        return <ConversationIndexRoute key={`${context.principal.ownerId}:${context.deviceView.generation}`} context={context} routes={routes} navigate={navigateRoute} />;
      case 'create':
        return (
          <KhalaPageFrame model={{ title: 'Khala', description: 'Create a private channel and share its link.', labelledBy: 'khala-create-title' }}>
            <CreateChannelScreen ports={context} mode="on_demand" onOpenRoom={roomId => navigateRoute(routes.roomPath(roomId))} />
          </KhalaPageFrame>
        );
      case 'join':
        return <JoinRoute context={context} routes={routes} navigateExternal={navigateExternal} navigateRoute={navigateRoute} />;
      case 'channel':
        return renderRoom(context, route, navigateRoute, routes);
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
    <OwnerShell key={context.principal.ownerId} application={application} createController={createChannelAccess} routes={routes} chrome={chrome}>
      {children}
    </OwnerShell>
  );

  return (
    <HumanScreen
      application={application}
      routes={routes}
      mode={mode}
      renderRoute={renderRoute}
      renderSignedOut={path => <SignInPanel identity={identity} path={path} isJoin={routes.parse(path).kind === 'join'} navigateExternal={navigateExternal} />}
      renderDeviceLoss={() => <LostDevicePanel />}
      attachCapabilities={attachCapabilities}
      renderReadyShell={renderReadyShell}
      renderSignedInAction={shellMode => <LogoutAction application={application} routes={routes} mode={shellMode} />}
    />
  );
}

export function mountKhalaContent(options: MountKhalaContentOptions): KhalaContentHandle {
  const root: Root = createRoot(options.target);
  root.render(<HumanApplicationScreen {...options} />);
  return { dispose: () => root.unmount() };
}
