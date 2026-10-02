import { AgentConfirm, AgentConfirmFrame } from '../../features/agent-confirm/AgentConfirm';
import { createAgentConfirmController } from '../../features/agent-confirm/controller';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import type { ShellMode } from '../../shell/types';
import { createJoinController } from '../../features/join/controller';
import { JoinScreen } from '../../features/join/JoinScreen';
import type { JoinView } from '../../features/join/model';
import type { HumanApplicationHandle, HumanRouteContext } from './application';
import type { HumanRoute, HumanRouteCodec } from './routes';
import { HumanScreen, type HumanShellChrome } from './screen';
import { ConversationIndexRoute } from './ConversationIndexRoute';
import { useConversationIndex } from './ConversationIndexRoute';
import { ConversationList, type ConversationSummary } from '../../ui/conversation';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import { LogOutIcon, PlusIcon } from '../../ui/khala/icons';
import { NewChannelPopover } from '../../ui/khala/NewChannelPopover';
import { SettingsMenu } from '../../ui/khala/SettingsMenu';
import { ProfileProvider, useProfile } from '../../features/profile/ProfileProvider';
import { ProfileDialog } from '../../features/profile/ProfileDialog';
import { UsernameGate } from '../../features/profile/UsernameGate';

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

/** The confirm page draws its own full-viewport frame (§20), with the shell's theme. */
function ConfirmFrame({ chrome, routes, children }: { chrome: HumanShellChrome; routes: HumanRouteCodec; children: ReactNode }) {
  return <AgentConfirmFrame theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
    homeHref={routes.conversationsPath()}>{children}</AgentConfirmFrame>;
}

function AgentConfirmRoute({ context, chrome, joinId, routes, navigateRoute }: {
  context: HumanRouteContext;
  chrome: HumanShellChrome;
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
  if (!controller) {
    return <ConfirmFrame chrome={chrome} routes={routes}>
      <h1 className="kh-fin-n">Agent confirmation unavailable</h1>
      <p className="kh-fin-p kh-fin-err" role="alert">Khala is unavailable right now.</p>
    </ConfirmFrame>;
  }
  return <AgentConfirm controller={controller} roomHref={routes.roomPath}
    theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange} homeHref={routes.conversationsPath()}
    onOpenRoom={roomId => navigateRoute(routes.roomPath(roomId))} />;
}

/** Starts sign-in that returns to `path` and leaves the page; false when sign-in cannot start. */
export async function redirectToSignIn(identity: IdentityPort, path: string,
  navigateExternal: (url: string) => void): Promise<boolean> {
  try {
    const result = await identity.beginSignIn(path);
    if (result.kind !== 'ok') return false;
    navigateExternal(result.value.url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every signed-out route goes straight to sign-in and back to the same path.
 * Cancelled and failed sign-ins return to the landing page, which reports them.
 */
function SignInRedirect({ identity, path, navigateExternal }: {
  identity: IdentityPort;
  path: string;
  navigateExternal: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const signIn = useCallback(() => {
    setFailed(false);
    void redirectToSignIn(identity, path, navigateExternal).then(ok => { if (!ok) setFailed(true); });
  }, [identity, navigateExternal, path]);

  useEffect(() => {
    // StrictMode replays effects; one mount starts one sign-in.
    if (started.current) return;
    started.current = true;
    signIn();
  }, [signIn]);

  if (failed) {
    return (
      <div className="kh-state-c" role="alert">
        <b>Sign-in is unavailable right now.</b>
        <button type="button" className="kh-btn" onClick={signIn}>Try again</button>
      </div>
    );
  }
  return (
    <section className="kh-state" aria-label="Signing in">
      <SigningIn />
    </section>
  );
}

function SigningIn() {
  return <div className="kh-state-c"><span className="kh-spin" aria-hidden="true"></span><b>Signing in…</b></div>;
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

type SignOut = Readonly<{ signOut(): void; signingOut: boolean; failed: boolean }>;

/** Signs out once at a time; in the standalone shell the URL returns to create. */
function useSignOut(application: HumanApplicationHandle, routes: HumanRouteCodec, mode: ShellMode): SignOut {
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigningOut(true);
    setFailed(false);
    try {
      const result = await application.signOut();
      if (result.kind !== 'ok') setFailed(true);
      else if (mode === 'standalone') globalThis.history?.replaceState(null, '', routes.createPath());
    } finally {
      inFlight.current = false;
      setSigningOut(false);
    }
  }

  return { signOut: () => void run(), signingOut, failed };
}

/** The brand row's sign-out messages, kept beside the control that started it. */
function SignOutStatus({ signingOut, failed }: Pick<SignOut, 'signingOut' | 'failed'>) {
  return <>
    {failed ? <span className="kh-brand-status" role="alert">Log out failed. Try again.</span> : null}
    {signingOut ? <span className="kh-brand-status" role="status">Logging out…</span> : null}
  </>;
}

/** The standalone Log out button, for signed-in failure screens outside the owner shell. */
export function LogoutAction({ application, routes, mode }: {
  application: HumanApplicationHandle;
  routes: HumanRouteCodec;
  mode: ShellMode;
}) {
  const { signOut, signingOut, failed } = useSignOut(application, routes, mode);
  return <>
    <SignOutStatus signingOut={signingOut} failed={failed} />
    <button type="button" className="tool-btn icon-only" aria-label="Log out" title="Log out"
      disabled={signingOut} onClick={signOut}><LogOutIcon /></button>
  </>;
}

function PendingOwnerShell({ application, routes, chrome, phase, children }: {
  application: HumanApplicationHandle;
  routes: HumanRouteCodec;
  chrome: HumanShellChrome;
  phase: 'checking_identity' | 'initializing_device' | 'inactive' | 'unavailable';
  children: ReactNode;
}) {
  const { signOut, signingOut, failed } = useSignOut(application, routes, chrome.mode);
  // No Log out while identity is still being checked; the theme stays switchable.
  const checking = phase === 'checking_identity';
  // The device status and its retry stay reachable on a phone: the pending
  // frame stacks the list above the status instead of hiding either.
  return <KhalaApp className="khala-owner-shell khala-pending" theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
    homeHref={routes.conversationsPath()} brandActions={checking ? null : <SignOutStatus signingOut={signingOut} failed={failed} />}
    brandMenu={<SettingsMenu theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
      username={null} {...(checking ? {} : { onSignOut: signOut, signingOut })} />}
    list={<ConversationList conversations={[]} selectedId={null} query="" onQueryChange={() => undefined} onSelect={() => undefined}
      showSearch={false} status={phase === 'unavailable' || phase === 'inactive' ? 'ready' : 'loading'}
      emptyLabel={phase === 'inactive' ? 'Channels are paused in this tab.' : 'Channels are unavailable on this device.'}
      action={<button type="button" className="kh-ib sm" aria-label="New channel" disabled><PlusIcon /></button>} />}
    main={children} />;
}

/** Adds each agent member's harness and owner, once a room has resolved them: the list shows the logo and owner badge (§4.1). */
function withHarnesses(conversations: readonly ConversationSummary[], describe: HumanRouteContext['describeMatrixUser']): readonly ConversationSummary[] {
  if (!describe) return conversations;
  return conversations.map(item => item.members ? { ...item, members: item.members.map(member => {
    const detail = member.kind === 'agent' ? describe(member.id) : undefined;
    return detail?.kind === 'agent' ? { ...member, harness: detail.harness, ownerId: detail.ownerId } : member;
  }) } : item);
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
  const closeCreate = useCallback(() => setCreating(false), []);
  const openCreatedRoom = useCallback((roomId: string) => navigateRoute(routes.roomPath(roomId)), [navigateRoute, routes]);
  useEffect(() => { setCreating(false); }, [chrome.path]);
  const { username, color } = useProfile();
  const [editingProfile, setEditingProfile] = useState(false);
  const closeProfile = useCallback(() => setEditingProfile(false), []);
  const { signOut, signingOut, failed } = useSignOut(application, routes, chrome.mode);
  const inThread = route.kind === 'channel' || route.kind === 'join';
  return <KhalaApp className="khala-owner-shell" theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
    homeHref={routes.conversationsPath()} inThread={inThread}
    brandActions={<SignOutStatus signingOut={signingOut} failed={failed} />}
    brandMenu={<SettingsMenu theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange}
      username={username} color={color} onEditProfile={() => setEditingProfile(true)} onSignOut={signOut} signingOut={signingOut} />}
    overlay={editingProfile ? <ProfileDialog ownerId={context.principal.ownerId} onClose={closeProfile} /> : undefined}
    list={<ConversationList conversations={withHarnesses(conversations ?? [], context.describeMatrixUser)} selectedId={route.kind === 'channel' ? route.roomId : null}
      query={query} onQueryChange={setQuery} viewerOwnerId={context.principal.ownerId}
      status={!context.conversations || conversations === null ? 'error' : conversations === undefined ? 'loading' : 'ready'}
      action={<>
        <button ref={createButton} type="button" className="kh-ib sm" data-tip="New channel" aria-label="New channel" aria-expanded="false"
          onClick={() => setCreating(open => !open)}><PlusIcon /></button>
        <NewChannelPopover anchor={createButton} open={creating} onClose={closeCreate} ports={context} onOpenRoom={openCreatedRoom} />
      </>}
      onSelect={id => { if (conversations?.some(item => item.id === id)) navigateRoute(routes.roomPath(id)); }} />}
    main={children} />;
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
  const renderRoute = (context: HumanRouteContext, route: HumanRoute, chrome: HumanShellChrome): ReactNode => {
    switch (route.kind) {
      case 'conversations':
        return <ConversationIndexRoute />;
      case 'join':
        return <JoinRoute context={context} routes={routes} navigateExternal={navigateExternal} navigateRoute={navigateRoute} />;
      case 'agent_confirm':
        return <AgentConfirmRoute context={context} chrome={chrome} joinId={route.joinId} routes={routes} navigateRoute={navigateRoute} />;
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
  // The agent confirm page is a standalone page (§20): no owner shell, while it
  // loads or waits for the device either.
  const isConfirm = (chrome: HumanShellChrome) => routes.parse(chrome.path).kind === 'agent_confirm';
  const renderAppShell = (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode, phase: 'ready' | 'navigating') => {
    if (isConfirm(chrome)) return phase === 'ready' ? children : <ConfirmFrame chrome={chrome} routes={routes}>{children}</ConfirmFrame>;
    return <OwnerShell key={context.principal.ownerId} application={application} routes={routes} chrome={chrome} context={context} navigateRoute={navigateRoute}>
      {children}
    </OwnerShell>;
  };
  // A human without a username chooses one before any app route, the confirm
  // page included. The URL is left alone, so saving lands on the asked-for route.
  const renderReadyShell = (context: HumanRouteContext, chrome: HumanShellChrome, children: ReactNode, phase: 'ready' | 'navigating') => {
    const pending = isConfirm(chrome)
      ? <ConfirmFrame chrome={chrome} routes={routes}><SigningIn /></ConfirmFrame>
      : <PendingOwnerShell application={application} routes={routes} chrome={chrome} phase="checking_identity"><SigningIn /></PendingOwnerShell>;
    return <ProfileProvider key={context.principal.ownerId} ports={context}>
      <UsernameGate pending={pending} theme={chrome.theme.theme} onThemeChange={chrome.theme.onThemeChange} homeHref={routes.conversationsPath()}
        brandActions={<LogoutAction application={application} routes={routes} mode={chrome.mode} />}>
        {renderAppShell(context, chrome, children, phase)}
      </UsernameGate>
    </ProfileProvider>;
  };
  const renderPendingShell = (chrome: HumanShellChrome, phase: 'checking_identity' | 'initializing_device' | 'inactive' | 'unavailable',
    children: ReactNode) => isConfirm(chrome)
    ? <ConfirmFrame chrome={chrome} routes={routes}>{children}</ConfirmFrame>
    : <PendingOwnerShell application={application} routes={routes} chrome={chrome} phase={phase}>{children}</PendingOwnerShell>;

  return (
    <HumanScreen
      application={application}
      routes={routes}
      mode={mode}
      renderRoute={renderRoute}
      renderSignedOut={path => <SignInRedirect key={path} identity={identity} path={path} navigateExternal={navigateExternal} />}
      renderDeviceLoss={() => <LostDevicePanel />}
      renderReadyShell={renderReadyShell}
      renderPendingShell={renderPendingShell}
      renderSignedInAction={shellMode => <LogoutAction application={application} routes={routes} mode={shellMode} />}
    />
  );
}

export function mountKhalaContent(options: MountKhalaContentOptions): KhalaContentHandle {
  const root: Root = createRoot(options.target);
  root.render(<HumanApplicationScreen {...options} />);
  return { dispose: () => root.unmount() };
}
