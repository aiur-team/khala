import { useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Panel } from '../../shell/Panel';
import type { StopController, StopView } from './stop-controller';
import type { RemainingBinding, StopFailure, StoppedBinding } from './stop-port';

// Stop revokes this channel's agent bindings and ends Khala delivery to them.
// It never closes an agent CLI, the local server, the channel or this page, and
// the copy says exactly that. An agent comes back only through the shared
// channel access flow: a new join request the human approves.

export type StopControlProps = Readonly<{
  controller: StopController;
  /** The channel URL an agent CLI joins with to request access again. */
  replacementAccessUrl: string;
}>;

const FAILURES: Record<StopFailure, string> = {
  unavailable: 'Khala could not confirm that Stop finished. Agents may still receive messages. Try again.',
  session_ended: 'This local session has ended, so Stop was not sent. Relaunch Khala from your terminal.',
  forbidden: 'This session cannot stop agents in this channel.',
  rejected: 'The agents in this channel changed while Stop was running. Try again.',
};

function agentLabel(binding: StoppedBinding): string {
  return `${binding.harness} agent (${binding.agentParticipantId}, binding ${binding.bindingId})`;
}

function remainingReason(binding: RemainingBinding): string {
  return binding.reason === 'revoke_failed'
    ? 'its binding could not be revoked'
    : 'its binding is revoked, but the local runtime file still lists it';
}

function statusText(view: StopView): string {
  switch (view.phase) {
    case 'stopping':
      return 'Stopping agent delivery…';
    case 'stopped':
      return view.stopped.length === 0
        ? 'No agent was receiving messages in this channel. Nothing needed to stop.'
        : `Agent delivery stopped. ${view.stopped.length === 1 ? '1 agent binding was' : `${view.stopped.length} agent bindings were`} revoked.`;
    default:
      return '';
  }
}

export function StopControl({ controller, replacementAccessUrl }: StopControlProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  const headingId = useId();
  const stopButton = useRef<HTMLButtonElement | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement | null>(null);
  const resultHeading = useRef<HTMLHeadingElement | null>(null);
  const previous = useRef<StopView['phase']>(view.phase);

  // Focus follows the flow: into the confirmation, back to Stop on cancel, onto the outcome.
  useEffect(() => {
    const from = previous.current;
    previous.current = view.phase;
    if (from === view.phase) return;
    // A disabled confirm button would drop focus to the page, so in-flight focus stays on the question.
    if (view.phase === 'confirming' || view.phase === 'stopping') confirmHeading.current?.focus();
    else if (view.phase === 'idle' && from === 'confirming') stopButton.current?.focus();
    else if (view.phase === 'stopped' || view.phase === 'partial' || view.phase === 'failed') resultHeading.current?.focus();
  }, [view.phase]);

  const stopping = view.phase === 'stopping';
  const onConfirmKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !stopping) {
      event.preventDefault();
      controller.cancel();
    }
  };

  return (
    <Panel heading="Agent delivery">
      <div className="stop-control" aria-busy={stopping}>
        <p>
          Stop ends Khala delivery to every agent in this channel. Agent command-line sessions you started keep running.
          This channel and this page stay open.
        </p>
        <p className="stop-control__status" role="status" aria-live="polite">{statusText(view)}</p>

        {view.phase === 'confirming' || view.phase === 'stopping' ? (
          <div className="stop-control__confirm" role="group" aria-labelledby={headingId} onKeyDown={onConfirmKey}>
            <h3 id={headingId} ref={confirmHeading} tabIndex={-1}>Stop delivery to agents in this channel?</h3>
            <ul>
              <li>Khala revokes every agent binding in this channel and delivers nothing more to those agents.</li>
              <li>Khala does not close, interrupt or signal any agent command-line session. Close them yourself if you want them to end.</li>
              <li>The local Khala server, this channel, its history and this page keep working.</li>
              <li>An agent can rejoin only through a new channel access request that you approve.</li>
            </ul>
            <div className="stop-control__actions">
              <button type="button" className="stop-control__confirm-button" onClick={() => controller.confirm()} disabled={stopping}>
                {stopping ? 'Stopping…' : 'Stop delivery'}
              </button>
              <button type="button" onClick={() => controller.cancel()} disabled={stopping}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" ref={stopButton} className="stop-control__stop-button" onClick={() => controller.request()}>
            Stop agent delivery
          </button>
        )}

        {view.phase === 'stopped' ? (
          <div className="stop-control__result">
            <h3 ref={resultHeading} tabIndex={-1}>Agent delivery stopped</h3>
            {view.stopped.length > 0 ? (
              <ul>{view.stopped.map(binding => <li key={`${binding.bindingId}:${binding.generation}`}>{agentLabel(binding)}</li>)}</ul>
            ) : null}
            <p>
              Your agent command-line sessions are still running. To connect an agent again, run{' '}
              <code>/khala join {replacementAccessUrl}</code> in its session, then approve the new channel access request.
            </p>
            <p><a href={replacementAccessUrl}>Channel link for a new access request</a></p>
          </div>
        ) : null}

        {view.phase === 'partial' ? (
          <div className="stop-control__result" role="alert">
            <h3 ref={resultHeading} tabIndex={-1}>Stop did not finish</h3>
            <p>These agents may still receive messages:</p>
            <ul>
              {view.remaining.map(binding => (
                <li key={`${binding.bindingId}:${binding.generation}`}>{agentLabel(binding)}: {remainingReason(binding)}.</li>
              ))}
            </ul>
            {view.stopped.length > 0 ? <p>{view.stopped.length === 1 ? '1 other agent binding was' : `${view.stopped.length} other agent bindings were`} revoked.</p> : null}
            <button type="button" onClick={() => controller.retry()}>Retry Stop</button>
          </div>
        ) : null}

        {view.phase === 'failed' ? (
          <div className="stop-control__result" role="alert">
            <h3 ref={resultHeading} tabIndex={-1}>Stop failed</h3>
            <p>{FAILURES[view.reason]}</p>
            {view.reason === 'unavailable' || view.reason === 'rejected'
              ? <button type="button" onClick={() => controller.retry()}>Retry Stop</button>
              : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
