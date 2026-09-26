import { useState, useSyncExternalStore } from 'react';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { ACKNOWLEDGEMENT_SUPPORT_LABELS, RECEIPT_EVIDENCE_LABELS } from '../receipt-evidence/vocabulary';
import { Panel } from '../../shell/Panel';
import { StatusBadge, type StatusTone } from '../../shell/StatusBadge';
import type { ChannelAgentView, ChannelController } from './controller';
import type { AgentConnectionState } from './ports';

export interface AgentPresencePanelProps {
  controller: ChannelController;
  copyText?: (value: string) => Promise<void>;
}

const CONNECTION_LABEL: Record<AgentConnectionState, string> = {
  connected: 'Connected',
  stale: 'Connection stale',
  offline: 'Not connected',
  unknown: 'Connection unknown',
};

const CONNECTION_TONE: Record<AgentConnectionState, StatusTone> = {
  connected: 'positive',
  stale: 'caution',
  offline: 'caution',
  unknown: 'neutral',
};

function defaultCopyText(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

function Onboarding({ agent, copy, copyState }: {
  agent: ChannelAgentView;
  copy: (agent: ChannelAgentView) => void;
  copyState: 'idle' | 'copied' | 'failed';
}) {
  if (agent.connection === 'connected') return null;
  return (
    <section className="agent-presence__onboarding" aria-labelledby={`connect-${agent.participantId}`}>
      <h3 id={`connect-${agent.participantId}`}>Connect {agent.displayName}</h3>
      {agent.installCommand ? (
        <>
          <p>Give this one command to the agent:</p>
          <code className="agent-presence__command">{agent.installCommand}</code>
          <button type="button" className="agent-presence__copy" onClick={() => copy(agent)}>
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy install command'}
          </button>
        </>
      ) : agent.installCommandError ? (
        <p role="alert">The install command is unavailable right now.</p>
      ) : (
        <p role="status">Preparing the install command…</p>
      )}
    </section>
  );
}

export function AgentPresencePanel({ controller, copyText = defaultCopyText }: AgentPresencePanelProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [copyStatus, setCopyStatus] = useState<Readonly<{ participantId: ParticipantId | null; state: 'idle' | 'copied' | 'failed' }>>({
    participantId: null,
    state: 'idle',
  });
  const noConnectedAgents = !view.agents.some(agent => agent.connection === 'connected');
  const panelStatus = view.phase === 'loading' ? 'busy' : view.phase === 'unavailable' ? 'error' : view.agents.length === 0 ? 'empty' : 'idle';
  const panelStatusMessage = view.phase === 'unavailable'
    ? 'Agent presence is unavailable right now.'
    : view.phase === 'ready' && view.agents.length === 0
      ? 'No agents have joined this channel yet.'
      : null;

  function copy(agent: ChannelAgentView): void {
    if (!agent.installCommand) return;
    void copyText(agent.installCommand).then(
      () => setCopyStatus({ participantId: agent.participantId, state: 'copied' }),
      () => setCopyStatus({ participantId: agent.participantId, state: 'failed' }),
    );
  }

  return (
    <Panel
      heading="Agent presence"
      status={panelStatus}
      {...(panelStatusMessage ? { statusMessage: panelStatusMessage } : {})}
    >
      <div className="agent-presence">
        {noConnectedAgents ? view.agents.map(agent => (
          <Onboarding
            key={`onboarding-${agent.participantId}`}
            agent={agent}
            copy={copy}
            copyState={copyStatus.participantId === agent.participantId ? copyStatus.state : 'idle'}
          />
        )) : null}

        <ol className="agent-presence__list">
          {view.agents.map(agent => (
            <li key={agent.participantId} className="agent-presence__agent">
              <header className="agent-presence__agent-header">
                <div>
                  <h3>{agent.displayName}</h3>
                  <p>Owned by {agent.ownerDisplayName}</p>
                </div>
                <StatusBadge tone={CONNECTION_TONE[agent.connection]} label={CONNECTION_LABEL[agent.connection]} />
              </header>
              <dl className="agent-presence__facts">
                <div>
                  <dt>Route</dt>
                  <dd>{agent.routeLabel}</dd>
                </div>
                <div>
                  <dt>Batch-token return</dt>
                  <dd>{ACKNOWLEDGEMENT_SUPPORT_LABELS[agent.acknowledgement]}</dd>
                </div>
                <div>
                  <dt>Last receipt</dt>
                  <dd>
                    {agent.lastReceipt ? (
                      <>{RECEIPT_EVIDENCE_LABELS[agent.lastReceipt.kind]} <time dateTime={agent.lastReceipt.observedAt}>{agent.lastReceipt.observedAt}</time></>
                    ) : 'No delivery receipt yet'}
                  </dd>
                </div>
              </dl>
              {!noConnectedAgents ? (
                <Onboarding
                  agent={agent}
                  copy={copy}
                  copyState={copyStatus.participantId === agent.participantId ? copyStatus.state : 'idle'}
                />
              ) : null}
            </li>
          ))}
        </ol>
        <p className="agent-presence__copy-status" role="status" aria-live="polite">
          {copyStatus.state === 'copied' ? 'Install command copied.' : copyStatus.state === 'failed' ? 'Install command could not be copied.' : ''}
        </p>
      </div>
    </Panel>
  );
}
