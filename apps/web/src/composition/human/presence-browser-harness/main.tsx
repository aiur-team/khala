import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BindingId, ListeningMode, ModeSupport, ModeSupportMap, OwnerId, ParticipantId, RoomId } from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { AgentPresencePanel } from '../../../features/channel/AgentPresencePanel';
import type { ChannelController, ChannelView } from '../../../features/channel/controller';
import { AgentListeningControls } from '../../../features/agent-controls/AgentControlsPanel';
import type { AgentControlsConfig } from '../../../features/agent-controls/controller';
import type { AgentControlsPorts, AgentControlsSnapshot } from '../../../features/agent-controls/ports';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../../../features/channel/channel.css';
import '../../../features/agent-controls/agent-controls.css';

const OWNER = 'owner_mira' as OwnerId;
const AGENT = 'agent_scout' as ParticipantId;
const BINDING = 'binding_scout' as BindingId;
const ROOM = 'room_harness' as RoomId;
const result = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
if (!result.ok) throw new Error('Invalid limits');
const limits = result.value;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function support(status: 'proven' | 'experimental', mode: ListeningMode): ModeSupport {
  return { status, route: `interactive-${mode}`, testedVersion: '0.154.0', evidenceRef: `proof-${mode}`,
    evidenceRevision: 'rev-1', reason: status === 'experimental' ? 'Busy-turn ordering has not been proved.' : null };
}
const modes: ModeSupportMap = { steer: support('experimental', 'steer'), sync: support('proven', 'sync'), async: support('proven', 'async') };
const state: { requested: ListeningMode; version: number; submissions: number; actor: 'agent' | 'owner' | null } = {
  requested: 'sync', version: 1, submissions: 0, actor: null,
};
const listeners = new Set<(snapshot: AgentControlsSnapshot) => void>();
function snapshot(): AgentControlsSnapshot {
  return {
    binding: { v: 1, bindingId: BINDING, ownerId: OWNER, agentParticipantId: AGENT as never,
      deviceId: 'device_scout' as never, harness: 'codex', sessionId: 'session_scout', generation: 2 },
    bindingStatus: 'active', connection: 'connected', latestReceipt: null,
    capabilities: { v: 3, harness: 'codex', version: '0.154.0', adapterVersion: '1.0.0', support: 'tested',
      existingSession: 'khala_hosted_resume', immediateNotification: 'khala_hosted_idle', busy: 'queue',
      receiptEvidence: [], reconcileByReleaseId: 'while_queued', limits, evidenceRef: 'proof-hosted',
      modes, acknowledgement: 'batch_token_next_call' },
    policy: { bindingId: BINDING, generation: 2, effectiveVersion: 1, effectiveMode: 'review', paused: false },
    listening: { view: { bindingId: BINDING, generation: 2, requested: state.requested, version: state.version,
      experimentalGrants: [], hardCancelGrants: [], lastChangedBy: state.actor === null ? { kind: 'unknown' } :
        state.actor === 'owner' ? { kind: 'owner', participantId: 'owner_mira' as ParticipantId } :
          { kind: 'agent', participantId: AGENT },
      effective: state.requested === 'steer' ? null : state.requested,
      effectiveReason: state.requested === 'steer' ? 'experimental_grant_required' : null, support: modes },
      lastChange: null, siblingBindingIds: [], hardCancel: null, idleDelivery: 'unproven' },
  };
}
function notify() { for (const listener of listeners) listener(snapshot()); }
const ports: AgentControlsPorts = { agentControls: {
  readSnapshot: async () => { await delay(50); return snapshot(); },
  subscribe: (_binding, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  submitPolicy: async () => { throw new Error('unused'); },
  submitRouteGrant: async () => { throw new Error('unused'); },
  submitListeningMode: async command => {
    await delay(100);
    state.submissions += 1;
    document.getElementById('mode-submits')!.textContent = String(state.submissions);
    const base = { v: 1 as const, commandId: command.commandId, bindingId: BINDING, generation: 2 };
    if (command.expectedVersion !== state.version) {
      notify();
      return { ...base, outcome: 'conflict' as const, version: state.version, requested: state.requested,
        effective: snapshot().listening!.view.effective, reason: 'stale_version' };
    }
    state.requested = command.requested;
    state.version += 1;
    state.actor = 'owner';
    notify();
    return { ...base, outcome: 'applied' as const, version: state.version, requested: state.requested,
      effective: snapshot().listening!.view.effective, reason: null };
  },
} };
const config: AgentControlsConfig = { bindingId: BINDING, roomId: ROOM, peerParticipantId: AGENT,
  viewerOwnerId: OWNER, agentLabel: 'Scout', roomLabel: 'Conversation' };
const presenceView: ChannelView = { phase: 'ready', agents: [
  { participantId: AGENT, ownerId: OWNER, displayName: 'Scout', ownerDisplayName: 'Mira',
    connection: 'connected', routeLabel: 'Codex CLI', acknowledgement: 'batch_token_next_call', lastReceipt: null,
    installCommand: null, installCommandError: false },
  { participantId: 'agent_builder' as ParticipantId, ownerId: 'owner_theo' as OwnerId,
    displayName: 'Builder', ownerDisplayName: 'Theo', connection: 'unknown', routeLabel: 'Unverified',
    acknowledgement: 'unknown', lastReceipt: null, installCommand: null, installCommandError: false },
] };
const presence: ChannelController = { getSnapshot: () => presenceView, subscribe: () => () => {}, dispose: () => {} };

function Harness() {
  const [viewer, setViewer] = useState<OwnerId>(OWNER);
  return <main style={{ maxWidth: 560, margin: '1rem auto', padding: '0 1rem' }}>
    <h1>Conversation participants</h1>
    <button type="button" onClick={() => setViewer(viewer === OWNER ? 'owner_theo' as OwnerId : OWNER)}>Switch human</button>
    <button type="button" onClick={() => { state.requested = 'steer'; state.version += 1; state.actor = 'agent'; }}>Simulate agent mode change</button>
    <output id="mode-submits">0</output>
    <AgentPresencePanel controller={presence} viewerOwnerId={viewer} renameScope="room_harness"
      renameAgent={async () => 'accepted'}
      renderOwnerControls={agent => agent.participantId === AGENT ? <AgentListeningControls ports={ports} config={config} /> : null} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
