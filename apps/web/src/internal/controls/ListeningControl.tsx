import type { BindingId } from '@khala/contracts/delivery/index';
import { useId, useSyncExternalStore } from 'react';
import { agentLabelFor, lastChangeLabelFor } from '../../features/agent-controls/model';
import { Panel } from '../../shell/Panel';
import { FAILURE_TEXT, type ListeningController } from './listening-controller';
import { LISTENING_MODE_NAMES, type ListeningBinding, type ListeningModeName, modeOffered } from './listening-port';

// How and when each agent in this channel receives messages, and whether Khala
// holds them. Only a mode the agent's command-line tool has proven can be chosen;
// every other mode stays visible, disabled, with the reason. Pause holds new
// messages before any agent receives them; it never stops an agent that is working.

export type ListeningControlProps = Readonly<{ controller: ListeningController }>;

const MODES: Record<ListeningModeName, Readonly<{ label: string; description: string }>> = {
  steer: { label: 'Steer', description: 'Delivered at the agent\'s next tool boundary.' },
  sync: { label: 'Sync', description: 'Delivered when the agent finishes its turn, or with your next prompt.' },
  async: { label: 'Async', description: 'Delivered only when the agent reads the channel itself.' },
};

function effectiveText(binding: ListeningBinding): string {
  if (binding.effective !== null) return `In effect: ${MODES[binding.effective].label}.`;
  switch (binding.effectiveReason) {
    case 'capabilities_unavailable':
      return 'Not in effect: this agent\'s command-line tool has not reported what it can do yet, so no mode is proven.';
    case 'no_requested_mode':
      return 'Not in effect: no mode is proven for this agent\'s command-line tool, so none is requested.';
    case 'acknowledgement_unavailable':
      return 'Not in effect: Async needs a proven read receipt, which this agent does not have.';
    case 'experimental_grant_required':
      return 'Not in effect: this mode needs an experimental grant.';
    default:
      return 'Not in effect: the requested mode is not proven for this agent\'s command-line tool.';
  }
}

type AgentRowProps = Readonly<{
  binding: ListeningBinding;
  siblings: readonly BindingId[];
  controller: ListeningController;
  busy: boolean;
}>;

function AgentRow({ binding, siblings, controller, busy }: AgentRowProps) {
  const id = useId();
  const name = binding.displayName;
  // The hosted panel's label and last-change wording, so both surfaces name agents and actors alike.
  const agentLabel = agentLabelFor(binding.harness, binding.harnessVersion, binding.bindingId as BindingId, siblings);
  const lastChange = lastChangeLabelFor(
    { view: { version: binding.version, lastChangedBy: binding.lastChangedBy }, lastChange: null }, binding.ownedByViewer, agentLabel,
  );
  return (
    <section className="listening-control__agent" aria-labelledby={`${id}-name`}>
      <h3 id={`${id}-name`}>{name} <span className="listening-control__harness">({agentLabel})</span></h3>
      <p className="listening-control__delivery">
        {binding.paused
          ? 'Paused. Khala holds new messages for this agent until you resume.'
          : 'Receiving messages.'}
      </p>
      {binding.idleDelivery === 'unproven'
        ? <p className="listening-control__idle">Idle agents receive messages only at their next turn.</p>
        : null}
      <p className="listening-control__effective">
        {binding.requested === null ? 'Requested: none.' : `Requested: ${MODES[binding.requested].label}.`} {effectiveText(binding)}
      </p>
      <p className="listening-control__last-change">{lastChange}</p>
      <fieldset disabled={busy}>
        <legend>Listening mode for {name}</legend>
        {LISTENING_MODE_NAMES.map(mode => {
          const offered = modeOffered(binding, mode);
          const describedBy = `${id}-${mode}-reason`;
          return (
            <div className="listening-control__mode" key={mode}>
              <label>
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={mode}
                  checked={binding.requested === mode}
                  disabled={!offered}
                  aria-describedby={describedBy}
                  onChange={() => void controller.setMode(binding.bindingId, mode)}
                />
                {MODES[mode].label}{offered ? '' : ' (not proven for this agent)'}
              </label>
              <p id={describedBy} className="listening-control__reason">
                {MODES[mode].description} {binding.support[mode].reason ?? ''}
              </p>
            </div>
          );
        })}
      </fieldset>
      <button type="button" disabled={busy} onClick={() => void controller.setPaused(binding.bindingId, !binding.paused)}>
        {binding.paused ? `Resume delivery to ${name}` : `Pause delivery to ${name}`}
      </button>
    </section>
  );
}

export function ListeningControl({ controller }: ListeningControlProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  const siblings = view.bindings.map(binding => binding.bindingId as BindingId);
  return (
    <Panel heading="Listening modes">
      <div className="listening-control" aria-busy={view.phase === 'loading' || view.busy !== null}>
        <p>
          Choose when each agent in this channel receives new messages. Pause holds new messages for an agent; it does
          not stop an agent that is already working.
        </p>
        {view.phase === 'loading' ? <p>Loading agents…</p> : null}
        {view.phase === 'failed' && view.failure ? <p role="alert">{FAILURE_TEXT[view.failure]}</p> : null}
        {view.phase === 'ready' && view.bindings.length === 0 ? <p>No agent is connected to this channel.</p> : null}
        {view.bindings.map(binding => (
          <AgentRow key={`${binding.bindingId}:${binding.generation}`} binding={binding} siblings={siblings} controller={controller} busy={view.busy === binding.bindingId} />
        ))}
        <p className="listening-control__status" role="status">{view.notice}</p>
      </div>
    </Panel>
  );
}
