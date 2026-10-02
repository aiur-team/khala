import { AgentConfirm } from '../../features/agent-confirm/AgentConfirm';
import { createAgentConfirmController } from '../../features/agent-confirm/controller';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import type { ShellMode } from '../../shell/types';
import { createJoinController } from '../../features/join/controller';
import { AgentJoinGuidance, JoinScreen } from '../../features/join/JoinScreen';
import type { JoinView } from '../../features/join/model';
import type { HumanApplicationHandle, HumanRouteContext } from './application';
import type { HumanRoute, HumanRouteCodec } from './routes';
import { HumanScreen, type HumanShellChrome } from './screen';
import { ConversationIndexRoute } from './ConversationIndexRoute';
import { useConversationIndex } from './ConversationIndexRoute';
import { ConversationList } from '../../ui/conversation';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import { ChevronLeftIcon, LogOutIcon, PlusIcon } from '../../ui/khala/icons';
import { CreateChannelDialog } from './CreateChannelDialog';

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
    ...(context.channelLinks ? { channelLinks: context.channelLinks } : {}),
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

function AgentConfirmRoute({ context, joinId, routes, navigateRoute }: {
  context: HumanRouteContext;
  joinId: string;
  routes: HumanRouteCodec;
  navigateRoute: (path: string) => void;
}) {
  const controller = useMemo(() => context.agentJoin && context.inviteAgent
    ? createAgentConfirmController({ joinId, port: context.agentJoin, invite: context.inviteAgent }) : null,
  [context, joinId]);
  useEffect(() => {
    if (!controller) return;
    const dispose = context.registerDisposer(() => controller.dispose());
    controller.start();
    return dispose;
  }, [context, controller]);
  if (!controller) return <Panel heading="Agent confirmation unavailable">Khala is unavailable right now.</Panel>;
  return <AgentConfirm controller={controller} roomHref={routes.roomPath}
    onOpenRoom={roomId => navigateRoute(routes.roomPath(roomId))} />;
}

function SignInPanel({ identity, path, isJoin, navigateExternal }: {
  identity: IdentityPort;
  path: string;
  isJoin: boolean;
  navigateExternal: (url: string) => void;
}) {
  const [signInFailed, setSignInFailed] = useState(false);
  const signInOutcome = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('sign_in');

  async function signIn() {
    setSignInFailed(false);
    const result = await identity.beginSignIn(path);
    if (result.kind === 'ok') navigateExternal(result.value.url);
    else setSignInFailed(true);
  }

  return (
    <KhalaPageFrame model={{ title: 'Sign in to Khala', labelledBy: 'khala-sign-in' }}>
      <Panel>
        {signInOutcome === 'cancelled' ? <p role="status">Sign-in was cancelled. Choose Sign in to try again.</p> : null}
        {signInOutcome === 'error' ? <p role="alert">Sign-in could not be completed. Choose Sign in to try again.</p> : null}
        <button type="button" className="aiur-action" onClick={() => void signIn()}>Sign in</button>
        {isJoin ? <><p>Humans: sign in to accept this invitation.</p><AgentJoinGuidance /></> : null}
        {signInFailed ? <p role="alert">Sign-in is unavailable right now.</p> : null}
      </Panel>
    </KhalaPageFrame>
  );
}

function LostDevicePanel() {
  return (
      <Panel heading="Device keys unavailable">
        <p role="alert">Khala cannot open this device's encrypted messages or channels with the keys available here.</p>
        <p>If you still have a device or browser profile with its original keys, open Khala there to read its history. This browser profile cannot regain keys by retrying this page.</p>
        <p>If every device's keys are gone, earlier history cannot be recovered. Access from a new device requires a fresh authorized admission; this screen cannot grant one.</p>
      </Panel>
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
    {signOutFailed ? <span className="kh-brand-status" role="alert">Log out failed. Try again.</span> : null}
    {signingOut ? <span className="kh-brand-status" role="status">Logging out…</span> : null}
    <button type="button" className="tool-btn icon-only" aria-label="Log out" title="Log out"
      disabled={signingOut} onClick={() => void signOut()}><LogOutIcon /></button>
  </>;
}

function PendingOwnerShell({ application, routes, chrome, phase, children }: {
  application: HumanApplicationHandle;
  routes: HumanRouteCodec;
  chrome: HumanShellChrome;
  phase: 'checking_identity' | 'initializing_device' | 'inactive' | 'unavailable';
  children: ReactNode;
}) {
  const actions = phase === 'checking_identity' ? null
    : <LogoutAction application={application} routes={routes} mode={chrome.mode} />;
  // The device status and its retry stay reachable on a phone: the pending
  // frame stacks the list above the status instead of hiding either.
  return <KhalaApp className="khala-owner-shell khala-pending" theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
    homeHref={routes.conversationsPath()} brandActions={actions}
    list={<ConversationList conversations={[]} selectedId={null} query="" onQueryChange={() => undefined} onSelect={() => undefined}
      showSearch={false} status={phase === 'unavailable' || phase === 'inactive' ? 'ready' : 'loading'}
      emptyLabel={phase === 'inactive' ? 'Channels are paused in this tab.' : 'Channels are unavailable on this device.'}
      action={<button type="button" className="kh-ib sm" aria-label="Create channel" title="Create channel" disabled><PlusIcon /></button>} />}
    main={children} />;
}

function OwnerShell({ application, routes, chrome, context, navigateRoute, children }: {
  application: HumanApplicationHandle;
  routes: HumanRouteCodec;
  chrome: HumanShellChrome;
  context: HumanRouteContext;
  navigateRoute(path: string): void;
  children: ReactNode;
}) {
  const route = routes.parse(chrome.path);
  const conversations = useConversationIndex(context);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const restoreCreateFocus = useCallback(() => { createButton.current?.focus(); }, []);
  useEffect(() => { setCreating(false); }, [chrome.path]);
  const inThread = route.kind === 'channel';
  return <KhalaApp className="khala-owner-shell" theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
    homeHref={routes.conversationsPath()} inThread={inThread}
    brandActions={<LogoutAction application={application} routes={routes} mode={chrome.mode} />}
    list={<ConversationList conversations={conversations ?? []} selectedId={route.kind === 'channel' ? route.roomId : null}
      query={query} onQueryChange={setQuery} emptyLabel="No encrypted channels yet."
      status={!context.conversations || conversations === null ? 'error' : conversations === undefined ? 'loading' : 'ready'}
      action={<button ref={createButton} type="button" className="kh-ib sm" aria-label="Create channel" title="Create channel" onClick={() => setCreating(true)}><PlusIcon /></button>}
      onSelect={id => { if (conversations?.some(item => item.id === id)) navigateRoute(routes.roomPath(id)); }} />}
    main={<>
      {/* Phone-width thread view hides the list; the design's header back button (§5) replaces this. */}
      {inThread ? <div className="kh-shell-back"><button type="button" className="kh-back" aria-label="All conversations"
        onClick={() => navigateRoute(routes.conversationsPath())}><ChevronLeftIcon /></button></div> : null}
      {children}
    </>}
    overlay={creating ? <CreateChannelDialog context={context}
      returnFocus={restoreCreateFocus}
      onClose={() => setCreating(false)}
      onOpenRoom={roomId => { setCreating(false); navigateRoute(routes.roomPath(roomId)); }} /> : null} />;
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
}: HumanApplicationScreenProps) {
  const renderRoute = (context: HumanRouteContext, route: HumanRoute): ReactNode => {
    switch (route.kind) {
      case 'conversations':
        return <ConversationIndexRoute />;
      case 'join':
        return <JoinRoute context={context} routes={routes} navigateExternal={navigateExternal} navigateRoute={navigateRoute} />;
      case 'agent_confirm':
        return <AgentConfirmRoute context={context} joinId={route.joinId} routes={routes} navigateRoute={navigateRoute} />;
      case 'channel':
        return renderRoom(context, route, navigateRoute, routes);
      case 'not_found':
        return (
          <KhalaPageFrame model={{ title: 'Page not found', labelledBy: 'khala-not-found' }}>
            <p role="alert">This Khala link is not valid.</p>
          </KhalaPageFrame>
        );
    }
  };
  const renderReadyShell = (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode) => (
    <OwnerShell key={context.principal.ownerId} application={application} routes={routes} chrome={chrome} context={context} navigateRoute={navigateRoute}>
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
      renderReadyShell={renderReadyShell}
      renderPendingShell={(chrome, phase, children) => <PendingOwnerShell application={application} routes={routes}
        chrome={chrome} phase={phase}>{children}</PendingOwnerShell>}
      renderSignedInAction={shellMode => <LogoutAction application={application} routes={routes} mode={shellMode} />}
    />
  );
}

export function mountKhalaContent(options: MountKhalaContentOptions): KhalaContentHandle {
  const root: Root = createRoot(options.target);
  root.render(<HumanApplicationScreen {...options} />);
  return { dispose: () => root.unmount() };
}
