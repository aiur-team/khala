// The agent confirmation page as its own lightweight entry. It makes only
// control-API calls with the session cookie: no Matrix client, no device lock
// and no tab handoff, so it works in any tab or browser while Khala is open
// elsewhere. The server invites the agent once it is ready.

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { IdentityPort, IdentityState } from '@khala/contracts/messaging/index';
import { AgentConfirm, AgentConfirmFrame } from '../../features/agent-confirm/AgentConfirm';
import { createAgentConfirmController } from '../../features/agent-confirm/controller';
import type { AgentJoinPort } from '../../features/agent-confirm/ports';
import type { ProfilePort } from '../../features/profile/ports';
import { ProfileProvider } from '../../features/profile/ProfileProvider';
import { UsernameGate } from '../../features/profile/UsernameGate';
import { persistTheme, resolveInitialTheme } from '../../shell/theme';
import type { ThemeChoice } from '../../shell/types';
import { SignInRedirect, SigningIn } from './mount';
import type { HumanRouteCodec } from './routes';

export type AgentConfirmPageProps = Readonly<{
  identity: IdentityPort;
  agentJoin: AgentJoinPort;
  profile: ProfilePort;
  routes: HumanRouteCodec;
  joinId: string;
  /** This page's own path, where sign-in returns. */
  path: string;
  navigateExternal?: (url: string) => void;
}>;

export function AgentConfirmPage({ identity, agentJoin, profile, routes, joinId, path,
  navigateExternal = url => globalThis.location?.assign(url) }: AgentConfirmPageProps) {
  const [theme, setTheme] = useState<ThemeChoice>(() => resolveInitialTheme(typeof localStorage === 'undefined' ? {} : { storage: localStorage }));
  const onThemeChange = (next: ThemeChoice) => {
    setTheme(next);
    if (typeof localStorage !== 'undefined') persistTheme(next, localStorage);
  };
  const [state, setState] = useState<IdentityState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState(null);
    identity.current().then(next => { if (live) setState(next); }, () => { if (live) setState({ kind: 'unavailable', retryable: true }); });
    return () => { live = false; };
  }, [identity, attempt]);
  const homeHref = routes.conversationsPath();
  const frame = { theme, onThemeChange, homeHref };

  if (state?.kind === 'signed_out') {
    return <AgentConfirmFrame {...frame}><SignInRedirect identity={identity} path={path} navigateExternal={navigateExternal} /></AgentConfirmFrame>;
  }
  if (state?.kind === 'unavailable') {
    return <AgentConfirmFrame {...frame}>
      <h1 className="kh-fin-n">Agent confirmation</h1>
      <p className="kh-fin-p kh-fin-err" role="alert">Khala is unavailable right now. Try again.</p>
      <button type="button" className="kh-btn" onClick={() => setAttempt(value => value + 1)}>Retry</button>
    </AgentConfirmFrame>;
  }
  const pending = <AgentConfirmFrame {...frame}><SigningIn /></AgentConfirmFrame>;
  if (state === null) return pending;
  // A new user picks a username first; the URL stays, so saving lands back here.
  return <ProfileProvider key={state.principal.ownerId} ports={{ profile }}>
    <UsernameGate pending={pending} {...frame}>
      <Confirm agentJoin={agentJoin} joinId={joinId} routes={routes} navigateExternal={navigateExternal} {...frame} />
    </UsernameGate>
  </ProfileProvider>;
}

function Confirm({ agentJoin, joinId, routes, navigateExternal, ...frame }: Readonly<{
  agentJoin: AgentJoinPort; joinId: string; routes: HumanRouteCodec; navigateExternal: (url: string) => void;
  theme: ThemeChoice; onThemeChange: (theme: ThemeChoice) => void; homeHref: string;
}>) {
  const controller = useMemo(() => createAgentConfirmController({ joinId, port: agentJoin }), [agentJoin, joinId]);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  // Open channel is a full load into the app, which takes the device there.
  return <AgentConfirm controller={controller} roomHref={routes.roomPath} {...frame}
    onOpenRoom={roomId => navigateExternal(routes.roomPath(roomId))} />;
}

export function mountAgentConfirmPage(target: Element, props: AgentConfirmPageProps): () => void {
  const root = createRoot(target);
  root.render(<AgentConfirmPage {...props} />);
  return () => root.unmount();
}
