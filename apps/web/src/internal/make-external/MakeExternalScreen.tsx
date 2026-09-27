import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  ConversionVisibility, HistoryMode, MakeExternalJourneyView,
} from '@khala/contracts/messaging/make-external';
import type { MakeExternalController, MakeExternalState } from './controller';
import {
  FAILURE_MESSAGE, HISTORY_CHOICES, STEP_HEADING, VISIBILITY_CHOICES, agentStatusLabel, deleteCommand, grantableHandles,
  historyProgressText, isPastCancel, stepOf, type JourneyStep,
} from './model';

/** Subscribes a component to the journey controller. */
export function useMakeExternalState(controller: MakeExternalController): MakeExternalState {
  const [state, setState] = useState<MakeExternalState>(() => controller.getState());
  useEffect(() => {
    setState(controller.getState());
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}

export type MakeExternalScreenProps = Readonly<{
  controller: MakeExternalController;
  /** Leaves the journey for the internal channel page; changes nothing. */
  onBack: () => void;
}>;

function Actions({ children }: { children: ReactNode }) {
  return <div className="make-external__actions">{children}</div>;
}

function ExternalLink({ view }: { view: MakeExternalJourneyView }) {
  const url = view.conversion?.destinationUrl;
  return url ? <a href={url} rel="noopener noreferrer" target="_blank">Open the external channel</a> : null;
}

function Orphan({ view }: { view: MakeExternalJourneyView }) {
  const orphan = view.conversion?.orphanDestinationChannelId;
  if (!orphan) return <p>No external channel was created.</p>;
  return (
    <div className="make-external__orphan">
      <p>
        An external channel was already created and is not used: <code>{orphan}</code>. It is not deleted automatically. Open it and
        delete it from Khala when you no longer need it.
      </p>
      <ExternalLink view={view} />
    </div>
  );
}

function Confirm({ view, busy, onStart, onCancel }: {
  view: MakeExternalJourneyView;
  busy: boolean;
  onStart: (choice: Readonly<{ historyMode: HistoryMode; visibility: ConversionVisibility; agents: readonly string[] }>) => void;
  onCancel: () => void;
}) {
  const [history, setHistory] = useState<HistoryMode | null>(null);
  const [visibility, setVisibility] = useState<ConversionVisibility>('secret');
  const [agents, setAgents] = useState<readonly string[]>(() => view.roster.map(agent => agent.participantId));
  const [missing, setMissing] = useState(false);
  const firstHistory = useRef<HTMLInputElement | null>(null);
  const errorId = useId();
  const selected = view.roster.filter(agent => agents.includes(agent.participantId));

  return (
    <form
      className="make-external__form"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        if (history === null) {
          setMissing(true);
          firstHistory.current?.focus();
          return;
        }
        onStart({ historyMode: history, visibility, agents });
      }}
    >
      <fieldset aria-describedby={missing ? errorId : undefined} aria-invalid={missing && history === null}>
        <legend>History</legend>
        {missing && history === null ? <p id={errorId} className="make-external__field-error">Choose what happens to this channel’s messages.</p> : null}
        {HISTORY_CHOICES.map((choice, index) => (
          <label key={choice.value} className="make-external__choice">
            <input
              ref={index === 0 ? firstHistory : undefined}
              type="radio"
              name="history"
              value={choice.value}
              checked={history === choice.value}
              onChange={() => setHistory(choice.value)}
            />
            <span><strong>{choice.label}</strong> {choice.description}</span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Who can find the external channel</legend>
        {VISIBILITY_CHOICES.map(choice => (
          <label key={choice.value} className="make-external__choice">
            <input type="radio" name="visibility" value={choice.value} checked={visibility === choice.value} onChange={() => setVisibility(choice.value)} />
            <span><strong>{choice.label}</strong> {choice.description}</span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Agents to bring</legend>
        {view.roster.length === 0 ? <p>No agent is bound to this channel. The external channel starts with you only.</p> : null}
        {view.roster.map(agent => (
          <label key={agent.participantId} className="make-external__choice">
            <input
              type="checkbox"
              checked={agents.includes(agent.participantId)}
              onChange={event => setAgents(current => event.target.checked
                ? [...current, agent.participantId]
                : current.filter(id => id !== agent.participantId))}
            />
            <span>
              <strong>{agent.displayName}</strong>{' '}
              <span className="make-external__meta">{agent.harness} session {agent.sessionId}, generation {agent.generation}</span>
            </span>
          </label>
        ))}
        <p className="make-external__note">
          Each selected agent gets its own access request in the new channel, and you grant each one. Nothing is granted by confirming.
        </p>
      </fieldset>
      <section aria-label="Summary" className="make-external__summary">
        <h3>Summary</h3>
        <ul>
          <li>History: {history === null ? 'not chosen yet' : HISTORY_CHOICES.find(choice => choice.value === history)!.label}</li>
          <li>Visibility: {VISIBILITY_CHOICES.find(choice => choice.value === visibility)!.label}</li>
          <li>Agents: {selected.length === 0 ? 'none' : selected.map(agent => agent.displayName).join(', ')}</li>
          <li>This channel stays active until the switch, then becomes read-only. It is not deleted.</li>
        </ul>
      </section>
      <Actions>
        <button type="submit" aria-disabled={busy}>Create the external channel</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </Actions>
    </form>
  );
}

function Agents({ view, controller, busy }: { view: MakeExternalJourneyView; controller: MakeExternalController; busy: boolean }) {
  const conversion = view.conversion!;
  const handles = grantableHandles(view);
  const waiting = conversion.agents.filter(agent => agent.status === 'requested');
  const commitHint = useId();
  return (
    <>
      {conversion.historyMode === 'carry_history' ? (
        <p className="make-external__note">History is copied. The internal channel is paused until you switch or cancel.</p>
      ) : null}
      {conversion.agents.length === 0 ? <p>No agent was selected.</p> : (
        <ul className="make-external__agents" aria-label="Agents">
          {conversion.agents.map(agent => (
            <li key={agent.participantId} className="make-external__agent">
              <span className="make-external__agent-name">{agent.displayName}</span>
              <span className="make-external__meta">{agent.harness} session {agent.sessionId}, generation {agent.generation}</span>
              <span className="make-external__agent-status">{agentStatusLabel(agent, false)}</span>
              <span className="make-external__agent-actions">
                {agent.status === 'blocked' ? (
                  <button type="button" onClick={() => void controller.act({ kind: 'retry', participantId: agent.participantId })}>
                    Retry {agent.displayName}
                  </button>
                ) : null}
                {agent.status === 'requested' || agent.status === 'blocked' || agent.status === 'verifying' ? (
                  <button type="button" onClick={() => void controller.act({ kind: 'skip', participantId: agent.participantId })}>
                    Skip {agent.displayName}
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {handles.length > 0 ? (
        <div className="make-external__grant">
          <p>Granting covers exactly these requests, each one individually: {waiting.map(agent => agent.displayName).join(', ')}.</p>
          <button type="button" onClick={() => void controller.act({ kind: 'grant', requestHandles: handles })}>
            Grant access to {handles.length === 1 ? '1 agent' : `${handles.length} agents`}
          </button>
        </div>
      ) : null}
      <Actions>
        <button
          type="button"
          aria-disabled={!conversion.canCommit || busy}
          aria-describedby={conversion.canCommit ? undefined : commitHint}
          onClick={() => {
            if (conversion.canCommit) void controller.act({ kind: 'commit' });
          }}
        >
          Switch to the external channel
        </button>
        <button type="button" onClick={() => void controller.act({ kind: 'resume' })}>Check again</button>
        <button type="button" onClick={() => void controller.act({ kind: 'cancel' })}>Cancel conversion</button>
      </Actions>
      {conversion.canCommit ? null : (
        <p id={commitHint} className="make-external__note">You can switch once every agent is ready or skipped.</p>
      )}
    </>
  );
}

function Body({ step, view, state, controller, onBack }: {
  step: JourneyStep;
  view: MakeExternalJourneyView;
  state: MakeExternalState;
  controller: MakeExternalController;
  onBack: () => void;
}) {
  const busy = state.busy !== null;
  const conversion = view.conversion;
  const cancel = <button type="button" onClick={() => void controller.act({ kind: 'cancel' })}>Cancel conversion</button>;
  switch (step) {
    case 'entry':
      return (
        <>
          <p>
            Make external creates a new hosted, end-to-end encrypted channel for this conversation. You sign in, choose what happens to the
            history and which agents come along, and grant each agent its own access. This channel becomes read-only only after the switch
            succeeds.
          </p>
          <Actions>
            <button type="button" onClick={() => void controller.act({ kind: 'sign_in' })}>Sign in to continue</button>
            <button type="button" onClick={onBack}>Cancel</button>
          </Actions>
        </>
      );
    case 'signing_in':
    case 'sign_in_again':
      return (
        <>
          {step === 'sign_in_again' ? <p>This conversion is saved. Khala needs a new hosted sign-in to continue it.</p> : null}
          {step === 'sign_in_again' && isPastCancel(view) ? (
            <p>
              The external channel is already authoritative and this channel is read-only. Signing in lets Khala finish activating
              your agents; it never reopens this channel.
            </p>
          ) : null}
          {view.signIn.verificationUrl ? (
            <p>
              Finish signing in on the hosted page, then return here. This page continues on its own.{' '}
              <a href={view.signIn.verificationUrl} rel="noopener noreferrer" target="_blank">Open the hosted sign-in page</a>
            </p>
          ) : null}
          <Actions>
            <button type="button" onClick={() => void controller.act({ kind: 'sign_in' })}>
              {view.signIn.status === 'pending' ? 'Start a new sign-in' : 'Sign in'}
            </button>
            {step !== 'sign_in_again'
              ? <button type="button" onClick={() => void controller.act({ kind: 'cancel' }).then(onBack)}>Cancel</button>
              : isPastCancel(view) ? null : cancel}
          </Actions>
        </>
      );
    case 'sign_in_failed':
      return (
        <>
          <p>
            {view.signIn.failure === 'expired' ? 'The sign-in expired.' : view.signIn.failure === 'denied' ? 'The sign-in was refused.' : 'The hosted service did not answer.'}{' '}
            Nothing changed and this channel is still active.
          </p>
          <Actions>
            <button type="button" onClick={() => void controller.act({ kind: 'sign_in' })}>Try signing in again</button>
            <button type="button" onClick={() => void controller.act({ kind: 'cancel' }).then(onBack)}>Cancel</button>
          </Actions>
        </>
      );
    case 'confirm':
      return (
        <Confirm
          view={view}
          busy={busy}
          onStart={choice => void controller.act({ kind: 'start', ...choice })}
          onCancel={() => void controller.act({ kind: 'cancel' }).then(onBack)}
        />
      );
    case 'preparing':
      return (
        <>
          <ol className="make-external__progress">
            <li>{conversion?.destinationChannelId ? 'External channel created.' : 'Creating the external channel…'}</li>
            {conversion?.historyMode === 'carry_history' ? <li>{historyProgressText(view) ?? 'Waiting to copy history…'}</li> : null}
            <li>Agent access requests follow once the channel {conversion?.historyMode === 'carry_history' ? 'holds the history' : 'exists'}.</li>
          </ol>
          <p className="make-external__note">This channel stays active while history copies.</p>
          <Actions>{cancel}</Actions>
        </>
      );
    case 'drain':
      return (
        <>
          <p>{historyProgressText(view)}</p>
          <p>
            New messages keep arriving faster than three catch-up rounds can copy them. To finish, Khala pauses this channel: people and agents
            cannot post while the rest of the history copies. If that cannot finish within its limit, the channel resumes and nothing moves.
          </p>
          <Actions>
            <button type="button" onClick={() => void controller.act({ kind: 'drain' })}>Pause this channel and finish copying</button>
            {cancel}
          </Actions>
        </>
      );
    case 'agents':
      return <Agents view={view} controller={controller} busy={busy} />;
    case 'committing':
      return <p>Writes to this channel are paused while Khala copies the final messages and links the two channels.</p>;
    case 'activating':
      return (
        <>
          <p>
            The external channel is now authoritative and this channel is read-only. Some agents are still being activated; Khala keeps
            finishing that and never reopens this channel.
          </p>
          <ul className="make-external__agents" aria-label="Agents">
            {conversion!.agents.map(agent => (
              <li key={agent.participantId} className="make-external__agent">
                <span className="make-external__agent-name">{agent.displayName}</span>
                <span className="make-external__agent-status">{agentStatusLabel(agent, true)}</span>
              </li>
            ))}
          </ul>
          <Actions>
            <button type="button" onClick={() => void controller.act({ kind: 'resume' })}>Retry activation</button>
            <ExternalLink view={view} />
          </Actions>
        </>
      );
    case 'done':
      return (
        <>
          <p>The external channel is authoritative. This internal channel is kept read-only on this computer.</p>
          <Actions>
            <ExternalLink view={view} />
            <button type="button" onClick={onBack}>View this read-only channel</button>
          </Actions>
          <p className="make-external__note">To delete the internal copy, run:</p>
          <pre><code>{deleteCommand(view.channelId)}</code></pre>
        </>
      );
    case 'cancelled':
    case 'failed':
      return (
        <>
          {step === 'failed' && conversion?.failure ? <p>{FAILURE_MESSAGE[conversion.failure]}</p> : null}
          <p>This channel is active again.</p>
          <Orphan view={view} />
          <Actions>
            <button type="button" onClick={() => void controller.act({ kind: 'dismiss' })}>Start again</button>
            <button type="button" onClick={onBack}>Back to the channel</button>
          </Actions>
        </>
      );
  }
}

/**
 * The Make-external journey for one internal channel. Every step heading takes focus
 * when the journey arrives at it, progress and results are announced politely, and
 * failures assertively.
 */
export function MakeExternalScreen({ controller, onBack }: MakeExternalScreenProps) {
  const state = useMakeExternalState(controller);
  const step = state.view ? stepOf(state.view) : null;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Mounted empty, then filled, so the first announcement is read.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (step !== null) headingRef.current?.focus();
  }, [step]);

  let heading = 'Make external';
  let body: ReactNode = null;
  if (state.phase === 'loading') body = <p>Loading…</p>;
  else if (state.phase === 'absent') body = <p>Make external is not available for this channel in this launch.</p>;
  else if (state.phase === 'session_ended') body = <p>This local session has ended. Relaunch Khala from your terminal to continue.</p>;
  else if (state.phase === 'load_failed') body = <button type="button" onClick={() => void controller.retry()}>Try again</button>;
  else if (state.view && step) {
    heading = STEP_HEADING[step];
    body = <Body step={step} view={state.view} state={state} controller={controller} onBack={onBack} />;
  }

  return (
    <section className="make-external" aria-labelledby="make-external-heading" aria-busy={state.busy !== null}>
      <h2 id="make-external-heading" ref={headingRef} tabIndex={-1}>{heading}</h2>
      <p role="status" aria-live="polite" className="make-external__status">{mounted ? state.announcement : ''}</p>
      <div role="alert" className="make-external__error">
        {state.error ? (
          <>
            <p>{state.error}</p>
            {state.retryable ? <button type="button" onClick={() => void controller.retry()}>Try again</button> : null}
          </>
        ) : null}
      </div>
      {body}
    </section>
  );
}
