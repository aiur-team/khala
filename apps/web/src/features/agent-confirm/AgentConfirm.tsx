// The agent confirmation page (RECREATION-SPEC §20): the design's agent-finish
// card `.kh-fin` on a full-viewport page, below the brand row (§1.4).

import { useState, useSyncExternalStore } from 'react';
import type { AgentJoinView, Harness } from '@khala/contracts/m1/agent-join';
import { persistTheme, resolveInitialTheme } from '../../shell/theme';
import type { ThemeChoice } from '../../shell/types';
import { CheckIcon } from '../../ui/khala/icons';
import { harnessLogo } from '../../ui/khala/identity';
import { Brand } from '../../ui/khala/KhalaApp';
import type { AgentConfirmController, AgentConfirmError } from './controller';
import '../../ui/khala/khala-app.css';
import './agent-confirm.css';

const harnessNames: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };
const errors: Record<AgentConfirmError, string> = {
  not_member: 'You are not a member of this channel.',
  not_found: 'This confirmation link is not valid.',
  expired: 'This request expired. Ask your agent to run khala_join again.',
  already_confirmed_by_other: 'Another member already confirmed this agent.',
  ready_timeout: 'The agent did not finish connecting.',
  invite_failed: 'Could not add the agent to the channel.',
  unavailable: 'Khala is unavailable right now. Try again.',
  signed_out: 'Khala is unavailable right now. Try again.',
};
const retryable: readonly AgentConfirmError[] = ['ready_timeout', 'invite_failed', 'unavailable', 'signed_out'];

function initialTheme(): ThemeChoice {
  return resolveInitialTheme(typeof localStorage === 'undefined' ? {} : { storage: localStorage });
}

/** The agent's identity at the top of the card: the harness chip and the page heading. */
function Agent({ view }: Readonly<{ view: AgentJoinView }>) {
  const logo = harnessLogo(view.harness);
  return <>
    <span className="kh-mchip" aria-hidden="true">{logo ? <img src={logo} alt="" /> : null}{harnessNames[view.harness]}</span>
    <h1 className="kh-fin-n">{view.label}</h1>
  </>;
}

export function AgentConfirm({ controller, roomHref, onOpenRoom, theme: hostTheme, onThemeChange, homeHref = '/conversations' }: {
  controller: AgentConfirmController;
  roomHref: (roomId: string) => string;
  onOpenRoom: (roomId: string) => void;
  /** The shell's theme; without one the page resolves and owns its own. */
  theme?: ThemeChoice;
  onThemeChange?: (theme: ThemeChoice) => void;
  /** Target of the wordmark. */
  homeHref?: string;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [ownTheme, setOwnTheme] = useState<ThemeChoice>(initialTheme);
  const theme = hostTheme ?? ownTheme;
  const view = snapshot.state === 'loading' ? undefined : snapshot.view;
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
          <span className="kh-fin-eb">Khala</span>
          {view ? <Agent view={view} /> : <h1 className="kh-fin-n">Agent confirmation</h1>}
          {snapshot.state === 'loading' ? <>
            <span className="kh-spin" aria-hidden="true" />
            <p className="kh-fin-p" role="status">Loading agent request…</p>
          </> : null}
          {snapshot.state === 'review' ? <>
            <p className="kh-fin-p" aria-hidden="true">wants to join <b>{snapshot.view.channelName}</b></p>
            <span className="kh-fin-sr">{snapshot.view.label} ({harnessNames[snapshot.view.harness]}) wants to join {snapshot.view.channelName}.</span>
            <button type="button" className="kh-btn pri" onClick={() => void controller.confirm()}>Confirm</button>
          </> : null}
          {snapshot.state === 'connecting' ? <>
            <span className="kh-spin" aria-hidden="true" />
            <p className="kh-fin-p" role="status">Connecting {snapshot.view.label}… Keep this tab open.</p>
          </> : null}
          {snapshot.state === 'done' ? <>
            <span className="kh-fin-ok"><CheckIcon />{snapshot.view.label} joined {snapshot.view.channelName}.</span>
            <a className="kh-btn pri" href={roomHref(snapshot.view.roomId)} onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpenRoom(snapshot.view.roomId);
            }}>Open channel</a>
          </> : null}
          {snapshot.state === 'error' ? <>
            <p className="kh-fin-p kh-fin-err" role="alert">{errors[snapshot.code]}</p>
            {retryable.includes(snapshot.code)
              ? <button type="button" className="kh-btn" onClick={() => controller.retry()}>Retry</button> : null}
          </> : null}
        </div>
      </section>
    </div>
  );
}
