import { useEffect, useState, useSyncExternalStore } from 'react';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { ACKNOWLEDGEMENT_SUPPORT_LABELS, RECEIPT_EVIDENCE_LABELS } from '../receipt-evidence/vocabulary';
import type { ChannelAgentView, ChannelController } from './controller';
import type { AgentConnectionState } from './ports';
import { participantRosterName } from './participant-name';

export interface AgentPresencePanelProps {
  controller: ChannelController;
  copyText?: (value: string) => Promise<void>;
  viewerOwnerId?: OwnerId;
  currentNames?: ReadonlyMap<ParticipantId, string>;
  namesPending?: boolean;
  renameAgent?: (participantId: ParticipantId, name: string, clientTxnId: string) => Promise<'accepted' | 'unknown' | 'rejected'>;
  renameScope?: string;
}

type PendingRename = { name: string; clientTxnId: string };

function readPending(key: string): PendingRename | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || !('name' in value) || !('clientTxnId' in value)
      || typeof value.name !== 'string' || typeof value.clientTxnId !== 'string'
      || !/^txn_[0-9a-f-]{36}$/u.test(value.clientTxnId)) return null;
    const checked = validateAgentName(value.name);
    return checked.ok && checked.name === value.name ? { name: value.name, clientTxnId: value.clientTxnId } : null;
  } catch { return null; }
}

function writePending(key: string, value: PendingRename | null): boolean {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

function RenameAgent({ agent, name, renameAgent, storageKey }: {
  agent: ChannelAgentView; name: string;
  renameAgent(participantId: ParticipantId, name: string, clientTxnId: string): Promise<'accepted' | 'unknown' | 'rejected'>;
  storageKey: string;
}) {
  const [pending, setPending] = useState<PendingRename | null>(() => readPending(storageKey));
  const [editing, setEditing] = useState(pending !== null);
  const [draft, setDraft] = useState(pending?.name ?? name);
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!pending || name !== pending.name) return;
    setEditing(false);
    setStatus('');
    setPending(null);
    writePending(storageKey, null);
  }, [name, pending, storageKey]);

  async function submit(): Promise<void> {
    const checked = validateAgentName(draft);
    if (!checked.ok) {
      setStatus(checked.error === 'blank' ? 'Enter a name.' : checked.error === 'too_long' ? 'Name is too long.'
        : checked.error === 'reserved' ? 'Choose a name that does not imply an official role.' : 'Remove invisible or control characters.');
      return;
    }
    if (checked.name === name && pending === null) { setStatus('This agent already has that name.'); return; }
    const request = pending ?? { name: checked.name, clientTxnId: `txn_${crypto.randomUUID()}` };
    if (pending && pending.name !== checked.name) { setStatus('Check the previous rename before choosing another name.'); return; }
    if (!writePending(storageKey, request)) { setStatus('This browser cannot safely keep the retry request. Check browser storage.'); return; }
    setPending(request);
    setSending(true);
    setStatus('Waiting for the channel to confirm the name…');
    try {
      const result = await renameAgent(agent.participantId, request.name, request.clientTxnId);
      if (result === 'rejected') { writePending(storageKey, null); setPending(null); setStatus('Name change was refused. Check your channel access and try again.'); }
      else if (result === 'unknown') setStatus('Delivery is unknown. Check delivery using the same request.');
    } catch {
      setStatus('Delivery is unknown. Check delivery using the same request.');
    } finally {
      setSending(false);
    }
  }
  return editing ? <form onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label htmlFor={`agent-name-${agent.participantId}`}>Agent name</label>
    <input id={`agent-name-${agent.participantId}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={80} />
    <button type="submit" disabled={sending}>{pending ? 'Check delivery' : 'Save name'}</button>
    <button type="button" onClick={() => { setEditing(false); setStatus(''); }}>Cancel</button>
    {status ? <p role="alert">{status}</p> : null}
  </form> : <button type="button" onClick={() => { setDraft(pending?.name ?? name); setEditing(true); }}
    aria-label={`Edit name for ${name}`}>{name === agent.displayName ? 'Name agent' : 'Edit name'}</button>;
}

const CONNECTION_LABEL: Record<AgentConnectionState, string> = {
  connected: 'Connected',
  stale: 'Connection stale',
  offline: 'Not connected',
  unknown: 'Connection unknown',
};

function defaultCopyText(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

function Onboarding({ agent, copy, copyState }: {
  agent: ChannelAgentView;
  copy: (agent: ChannelAgentView) => void;
  copyState: 'idle' | 'copied' | 'failed';
}) {
  if (agent.connection === 'connected' || agent.routeLabel === 'Channel agent') return null;
  return (
    <section className="agent-presence__onboarding" aria-labelledby={`connect-${agent.participantId}`}>
      <h3 id={`connect-${agent.participantId}`}>Connect {agent.displayName}</h3>
      {agent.installCommand ? (
        <>
          <p>Give this one command to the agent:</p>
          <code className="agent-presence__command">{agent.installCommand}</code>
          <button type="button" className="agent-presence__copy aiur-action" onClick={() => copy(agent)}>
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

export function AgentPresencePanel({ controller, copyText = defaultCopyText, viewerOwnerId, currentNames, namesPending = false, renameAgent, renameScope }: AgentPresencePanelProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [copyStatus, setCopyStatus] = useState<Readonly<{ participantId: ParticipantId | null; state: 'idle' | 'copied' | 'failed' }>>({
    participantId: null,
    state: 'idle',
  });
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
    <div className="agent-presence">
      {view.phase === 'loading' ? <p role="status">Loading…</p> : null}
      {panelStatusMessage ? <p role="status">{panelStatusMessage}</p> : null}
      <ol className="agent-presence__list">
        {view.agents.map(agent => {
          const name = participantRosterName(currentNames?.get(agent.participantId) ?? agent.displayName, 'Agent');
          return <li key={agent.participantId} className="agent-presence__agent">
            <details className="agent-presence__details">
              <summary aria-label={`Details for ${name}, ${CONNECTION_LABEL[agent.connection]}`}>
                <span className="channel-participants__avatar" aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase()}</span>
                <span className="agent-presence__identity"><span className="agent-presence__name">{name}</span>
                  <span className={`agent-presence__status agent-presence__status--${agent.connection}`}>{CONNECTION_LABEL[agent.connection]}</span></span>
                <span className="agent-presence__chevron" aria-hidden="true">⌄</span>
              </summary>
              <div className="agent-presence__detail-body">
                <p>Owned by {participantRosterName(agent.ownerDisplayName, 'Channel member')}</p>
                {!namesPending && renameAgent && viewerOwnerId && renameScope && agent.ownerId === viewerOwnerId ? <RenameAgent
                  agent={agent} name={currentNames?.get(agent.participantId) ?? agent.displayName} renameAgent={renameAgent}
                  storageKey={`khala:pending-rename:${JSON.stringify([viewerOwnerId, renameScope, agent.participantId])}`} /> : null}
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
                <Onboarding agent={{ ...agent, displayName: name }} copy={copy}
                  copyState={copyStatus.participantId === agent.participantId ? copyStatus.state : 'idle'} />
              </div>
            </details>
          </li>;
        })}
      </ol>
      <p className="agent-presence__copy-status" role="status" aria-live="polite">
        {copyStatus.state === 'copied' ? 'Install command copied.' : copyStatus.state === 'failed' ? 'Install command could not be copied.' : ''}
      </p>
    </div>
  );
}
