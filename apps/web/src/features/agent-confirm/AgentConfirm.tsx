// The agent confirmation page (RECREATION-SPEC §20): the design's agent-finish
// card `.kh-fin` on a full-viewport page, below the brand row (§1.4).

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { persistTheme, resolveInitialTheme } from '../../shell/theme';
import type { ThemeChoice } from '../../shell/types';
import { ChatIcon, CheckIcon, RestoreIcon, UserIcon, XIcon } from '../../ui/khala/icons';
import { Brand } from '../../ui/khala/KhalaApp';
import type { AgentConfirmController, AgentConfirmError } from './controller';
import '../../ui/khala/khala-app.css';
import './agent-confirm.css';

// A few words each (operator request): the page is a spinner and a status, not prose.
const errors: Record<AgentConfirmError, string> = {
  not_member: 'Not a member',
  wrong_account: 'Wrong account',
  invite_unavailable: 'Invite expired',
  not_found: 'Invalid link',
  expired: 'Request expired',
  already_confirmed_by_other: 'Already confirmed',
  not_picked_up: 'Agent not responding',
  not_finished: 'Join incomplete',
  unavailable: 'Khala unavailable',
  signed_out: 'Signed out',
};

function initialTheme(): ThemeChoice {
  return resolveInitialTheme(typeof localStorage === 'undefined' ? {} : { storage: localStorage });
}

/** Who is joining where, so the human sees it before approving. */
function Agent({ view }: Readonly<{ view: AgentJoinView }>) {
  return <h1 className="kh-fin-n">{view.label} <span aria-hidden="true">→</span><span className="kh-fin-sr">joins</span> {view.channelName}</h1>;
}

/** The one spinner and its status: at most two words, which may change by stage. */
function Status({ text }: Readonly<{ text: string }>) {
  return <><span className="kh-spin" aria-hidden="true" /><p className="kh-fin-p" role="status">{text}</p></>;
}

type PageTheme = Readonly<{
  /** The shell's theme; without one the page resolves and owns its own. */
  theme?: ThemeChoice;
  onThemeChange?: (theme: ThemeChoice) => void;
  /** Target of the wordmark. */
  homeHref?: string;
}>;

/**
 * The full-viewport page and its card, without a confirmation: the app shows
 * its device status here while the route waits for the device (§20).
 */
export function AgentConfirmFrame({ theme: hostTheme, onThemeChange, homeHref = '/conversations', children }: PageTheme & {
  children: ReactNode;
}) {
  const [ownTheme, setOwnTheme] = useState<ThemeChoice>(initialTheme);
  const theme = hostTheme ?? ownTheme;
  return (
    <div className="khala-app kh-agent-confirm" data-theme={theme}>
      <Brand theme={theme} homeHref={homeHref} onThemeChange={next => {
        if (hostTheme === undefined) {
          setOwnTheme(next);
          if (typeof localStorage !== 'undefined') persistTheme(next, localStorage);
        }
        onThemeChange?.(next);
      }} />
      <section className="kh-fin kh-fin--page" aria-label="Confirm agent">
        <div className="kh-fin-c">
          {children}
        </div>
      </section>
    </div>
  );
}

export function AgentConfirm({ controller, roomHref, onOpenRoom, ...page }: PageTheme & {
  controller: AgentConfirmController;
  roomHref: (roomId: string) => string;
  onOpenRoom: (roomId: string) => void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const view = snapshot.state === 'loading' ? undefined : snapshot.view;
  return (
    <AgentConfirmFrame {...page}>
      {view ? <Agent view={view} /> : null}
      {snapshot.state === 'loading' ? <Status text="Loading" /> : null}
      {snapshot.state === 'review' ? snapshot.view.access === 'auto' ? <>
        {/* Approve joins is off: the controller confirms after a few seconds unless cancelled. */}
        <Status text="Joining" />
        <button type="button" className="kh-btn" aria-label="Cancel" title="Cancel" onClick={() => controller.cancelAuto()}><XIcon /></button>
      </> : <button type="button" className="kh-btn pri" onClick={() => void controller.confirm()}
        {...(snapshot.view.access === 'join'
          ? { 'aria-label': 'Join and approve', title: 'Join and approve' }
          : { 'aria-label': 'Approve', title: 'Approve' })}><CheckIcon /></button> : null}
      {snapshot.state === 'connecting' ? <Status text="Connecting" /> : null}
      {snapshot.state === 'done' ? <>
        {/* `ready` means the server invited the agent; it joins once it accepts. */}
        <span className="kh-fin-ok" role="status"><CheckIcon />Joined</span>
        <a className="kh-btn pri" aria-label="Open channel" title="Open channel" href={roomHref(snapshot.view.roomId)} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenRoom(snapshot.view.roomId);
        }}><ChatIcon /></a>
      </> : null}
      {snapshot.state === 'error' ? <>
        <p className="kh-fin-p kh-fin-err" role="alert">{errors[snapshot.code]}</p>
        {/* A reload signs in through the page's own redirect and returns here. */}
        {snapshot.code === 'signed_out'
          ? <button type="button" className="kh-btn pri" aria-label="Sign in" title="Sign in" onClick={() => globalThis.location?.reload()}><UserIcon /></button> : null}
        {snapshot.code === 'unavailable' ? <RetryButton onClick={() => controller.retry()} /> : null}
      </> : null}
    </AgentConfirmFrame>
  );
}

export function RetryButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return <button type="button" className="kh-btn" aria-label="Retry" title="Retry" onClick={onClick}><RestoreIcon /></button>;
}
