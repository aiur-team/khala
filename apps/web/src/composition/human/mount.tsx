import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { AiurShell, ThemeToggle } from '../../shell/AiurShell';
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

function PendingOwnerShell({ application, routes, chrome, phase, children }: {
  application: HumanApplicationHandle;
  routes: HumanRouteCodec;
  chrome: HumanShellChrome;
  phase: 'checking_identity' | 'initializing_device' | 'inactive' | 'unavailable';
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerButton = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => { if (drawerOpen) drawerClose.current?.focus(); }, [drawerOpen]);
  const sidebar = <div ref={drawer} className={`khala-sidebar${drawerOpen ? ' khala-sidebar--open' : ''}`}
    role={drawerOpen ? 'dialog' : undefined} aria-modal={drawerOpen || undefined} aria-label={drawerOpen ? 'Channels' : undefined}
    onKeyDown={event => {
      if (event.key === 'Escape') { setDrawerOpen(false); drawerButton.current?.focus(); return; }
      if (event.key !== 'Tab' || !drawerOpen) return;
      const focusable = [...(drawer.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])]
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <button ref={drawerClose} type="button" className="khala-sidebar__close aiur-shell__icon-button" aria-label="Close channels"
      onClick={() => { setDrawerOpen(false); drawerButton.current?.focus(); }}>×</button>
    <ConversationList conversations={[]} selectedId={null} query="" onQueryChange={() => undefined} onSelect={() => undefined}
      showSearch={false} status={phase === 'unavailable' || phase === 'inactive' ? 'ready' : 'loading'}
      emptyLabel={phase === 'inactive' ? 'Channels are paused in this tab.' : 'Channels are unavailable on this device.'}
      action={<button type="button" className="aiur-shell__icon-button" aria-label="Create channel" title="Create channel" disabled>+</button>} />
  </div>;
  const actions = phase === 'checking_identity' ? null
    : <LogoutAction application={application} routes={routes} mode={chrome.mode} />;
  const hostedActions = <><ThemeToggle theme={chrome.theme} />{actions}</>;
  return <AiurShell mode={chrome.mode} className="khala-owner-shell" brandHref={routes.conversationsPath()}
    navigation={[]} sidebar={sidebar} actions={actions} theme={chrome.theme}
    collapsed={chrome.collapsed} onCollapsedChange={chrome.onCollapsedChange}>
    {chrome.mode === 'hosted-content' ? <div className="khala-content-actions"><div className="khala-content-actions__buttons">{hostedActions}</div></div> : null}
    <div className="khala-mobile-bar"><button ref={drawerButton} type="button" className="aiur-shell__icon-button" aria-label="Channels"
      aria-expanded={drawerOpen} onClick={() => setDrawerOpen(value => !value)}>☰</button><span>Channels</span>
      {chrome.mode === 'hosted-content' ? hostedActions : null}</div>
    {children}
  </AiurShell>;
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
  const selectedTitle = route.kind === 'channel'
    ? conversations?.find(item => item.id === route.roomId)?.title ?? 'Encrypted conversation'
    : 'Channels';
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerButton = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const restoreCreateFocus = useCallback(() => {
    (window.matchMedia('(max-width: 959px)').matches ? drawerButton.current : createButton.current)?.focus();
  }, []);
  useEffect(() => { setCreating(false); }, [chrome.path]);
  useEffect(() => { if (drawerOpen) drawerClose.current?.focus(); }, [drawerOpen]);
  const actions = <LogoutAction application={application} routes={routes} mode={chrome.mode} />;
  const hostedActions = <><ThemeToggle theme={chrome.theme} />{actions}</>;
  const sidebar = <>
    <ConversationList conversations={conversations ?? []} selectedId={route.kind === 'channel' ? route.roomId : null}
      query={query} onQueryChange={setQuery} emptyLabel="No encrypted channels yet."
      status={!context.conversations || conversations === null ? 'error' : conversations === undefined ? 'loading' : 'ready'}
      action={<button ref={createButton} type="button" className="aiur-shell__icon-button" aria-label="Create channel" title="Create channel" onClick={() => { setDrawerOpen(false); setCreating(true); }}>+</button>}
      onSelect={id => { if (conversations?.some(item => item.id === id)) { setDrawerOpen(false); navigateRoute(routes.roomPath(id)); } }} />
  </>;
  return (
    <AiurShell
      mode={chrome.mode}
      className="khala-owner-shell"
      {...(route.kind === 'channel' && chrome.mode !== 'hosted-content' ? { headerContent: <><button ref={drawerButton} type="button" className="khala-channel-drawer aiur-shell__icon-button" aria-label="Channels" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(value => !value)}>☰</button><div id="khala-channel-toolbar" /></> } : {})}
      navigation={[]}
      brandHref={routes.conversationsPath()}
      sidebar={<div ref={drawer} className={`khala-sidebar${drawerOpen ? ' khala-sidebar--open' : ''}`}
        role={drawerOpen ? 'dialog' : undefined} aria-modal={drawerOpen || undefined} aria-label={drawerOpen ? 'Channels' : undefined}
        onKeyDown={event => {
          if (event.key === 'Escape') { setDrawerOpen(false); drawerButton.current?.focus(); return; }
          if (event.key !== 'Tab' || !drawerOpen) return;
          const focusable = [...(drawer.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])]
            .filter(element => element.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <button ref={drawerClose} type="button" className="khala-sidebar__close aiur-shell__icon-button" aria-label="Close channels" onClick={() => { setDrawerOpen(false); drawerButton.current?.focus(); }}>×</button>
        {sidebar}</div>}
      actions={actions}
      theme={chrome.theme}
      collapsed={chrome.collapsed}
      onCollapsedChange={chrome.onCollapsedChange}
    >
      {chrome.mode === 'hosted-content' ? <div className="khala-content-actions">{route.kind === 'channel' ? <><button ref={drawerButton} type="button" className="khala-channel-drawer aiur-shell__icon-button" aria-label="Channels" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(value => !value)}>☰</button><div id="khala-channel-toolbar" /></> : null}<div className="khala-content-actions__buttons">{hostedActions}</div></div> : null}
      {route.kind !== 'channel' ? <div className="khala-mobile-bar"><button ref={drawerButton} type="button" className="aiur-shell__icon-button" aria-label="Channels" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(value => !value)}>☰</button><span>{selectedTitle}</span>{chrome.mode === 'hosted-content' ? hostedActions : null}</div> : null}
      {children}
      {creating ? <CreateChannelDialog context={context}
        returnFocus={restoreCreateFocus}
        onClose={() => setCreating(false)}
        onOpenRoom={roomId => { setCreating(false); navigateRoute(routes.roomPath(roomId)); }} /> : null}
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
}: HumanApplicationScreenProps) {
  const renderRoute = (context: HumanRouteContext, route: HumanRoute): ReactNode => {
    switch (route.kind) {
      case 'conversations':
        return <ConversationIndexRoute />;
      case 'join':
        return <JoinRoute context={context} routes={routes} navigateExternal={navigateExternal} navigateRoute={navigateRoute} />;
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
