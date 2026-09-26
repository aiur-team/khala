import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  BindingId, DeliveryLimits, ListeningMode, ModeSupport, ModeSupportMap, OwnerId, ParticipantId, PolicyAck, RoomId,
  RouteGrant,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { AgentControlsPanel } from '../AgentControlsPanel';
import type { AgentControlsConfig } from '../controller';
import type { AgentControlsPorts, AgentControlsSnapshot, ListeningModeLastChange } from '../ports';

/**
 * Synthetic port for the browser harness only. No real harness sessions,
 * network calls, or connector credentials: every response is fabricated
 * in-memory, and the submit methods are the only paths that change state.
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const BINDING_ID = 'bind_harness' as BindingId;
const SECOND_BINDING_ID = 'bind_harness_second' as BindingId;
const ROOM_ID = 'room_harness' as RoomId;
const PEER_ID = 'agent_harness' as ParticipantId;
const OWNER_ID = 'owner_harness' as OwnerId;
const CODEX_VERSION = '0.154.0';

const limitsResult = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
if (!limitsResult.ok) throw new Error('invalid harness limits');
const limits: DeliveryLimits = limitsResult.value;

const EVIDENCE_REGISTRY = { 'harness-codex-sync': '/evidence/harness-codex-sync' } as const;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: ROOM_ID,
  peerParticipantId: PEER_ID,
  // The harness viewer owns this binding, so the panel shows "Your agent" and
  // enables controls — matching the real host's authenticated-owner case.
  viewerOwnerId: OWNER_ID,
  agentLabel: 'agent-harness',
  roomLabel: 'channel-harness',
  evidenceRegistry: EVIDENCE_REGISTRY,
};

const SECOND_CONFIG: AgentControlsConfig = {
  ...CONFIG,
  bindingId: SECOND_BINDING_ID,
  agentLabel: 'agent-harness-second',
};

function support(status: 'proven' | 'experimental', mode: ListeningMode): ModeSupport {
  return {
    status,
    route: `harness-codex-${mode}`,
    testedVersion: CODEX_VERSION,
    evidenceRef: `harness-codex-${mode}`,
    evidenceRevision: 'rev-1',
    reason: status === 'experimental' ? 'Ordering under a busy turn is not proved.' : null,
  };
}

const MODES: ModeSupportMap = {
  steer: support('experimental', 'steer'),
  sync: support('proven', 'sync'),
  async: support('proven', 'async'),
};

type ListeningState = {
  requested: ListeningMode;
  version: number;
  experimentalGrants: RouteGrant[];
  hardCancelGrants: RouteGrant[];
  lastChange: ListeningModeLastChange | null;
};

type BindingState = {
  bindingId: BindingId;
  connection: AgentControlsSnapshot['connection'];
  listening: ListeningState;
  listeners: ((snapshot: AgentControlsSnapshot) => void)[];
  modeSubmits: number;
};

const generation = 0;
let effectiveVersion = 3;
const effectiveMode: 'review' | 'auto' = 'review';
let paused = false;

function bindingState(bindingId: BindingId): BindingState {
  return {
    bindingId,
    connection: 'connected',
    listening: { requested: 'sync', version: 1, experimentalGrants: [], hardCancelGrants: [], lastChange: null },
    listeners: [],
    modeSubmits: 0,
  };
}

const primary = bindingState(BINDING_ID);
const second = bindingState(SECOND_BINDING_ID);

function effectiveOf(state: ListeningState): ListeningMode | null {
  const selected = MODES[state.requested];
  if (selected.status === 'proven') return state.requested;
  const granted = state.experimentalGrants.some(grant => grant.mode === state.requested);
  return selected.status === 'experimental' && granted ? state.requested : null;
}

function currentSnapshot(state: BindingState): AgentControlsSnapshot {
  const listening = state.listening;
  const effective = effectiveOf(listening);
  return {
    binding: {
      v: 1,
      bindingId: state.bindingId,
      ownerId: OWNER_ID,
      agentParticipantId: 'agent_harness' as never,
      deviceId: 'device_harness' as never,
      harness: 'codex',
      sessionId: `thread_${state.bindingId}`,
      generation,
    },
    bindingStatus: 'active',
    capabilities: {
      v: 3,
      harness: 'codex',
      version: CODEX_VERSION,
      adapterVersion: '1.0.0',
      support: 'tested',
      existingSession: 'khala_hosted_resume',
      immediateNotification: 'khala_hosted_idle',
      busy: 'queue',
      receiptEvidence: [],
      reconcileByReleaseId: 'while_queued',
      limits,
      evidenceRef: 'evidence_harness',
      modes: MODES,
      acknowledgement: 'batch_token_next_call',
    },
    policy: { bindingId: state.bindingId, generation, effectiveVersion, effectiveMode, paused },
    connection: state.connection,
    latestReceipt: null,
    listening: {
      view: {
        bindingId: state.bindingId,
        generation,
        requested: listening.requested,
        version: listening.version,
        experimentalGrants: listening.experimentalGrants,
        hardCancelGrants: listening.hardCancelGrants,
        effective,
        effectiveReason: effective === null ? 'experimental_grant_required' : null,
        support: MODES,
      },
      lastChange: listening.lastChange,
      siblingBindingIds: [primary.bindingId, second.bindingId].filter(id => id !== state.bindingId),
      hardCancel: support('experimental', 'steer'),
      idleDelivery: 'unproven',
    },
  };
}

function notify(state: BindingState) {
  const snapshot = currentSnapshot(state);
  for (const listener of state.listeners) listener(snapshot);
  const submits = document.getElementById('mode-submits');
  if (submits) submits.textContent = String(primary.modeSubmits);
}

function portsFor(state: BindingState): AgentControlsPorts {
  return {
    agentControls: {
      readSnapshot: async () => {
        await delay(50);
        return currentSnapshot(state);
      },
      subscribe: (_bindingId, listener) => {
        state.listeners = [...state.listeners, listener];
        return () => {
          state.listeners = state.listeners.filter(l => l !== listener);
        };
      },
      submitPolicy: async command => {
        await delay(150);
        // This panel only ever requests `review` (KTD3): a harness that silently
        // accepted `auto` would let a controller regression pass this browser
        // test unnoticed, so a non-review mode is rejected the way a real
        // connector would reject an unsupported request.
        if (command.mode !== 'review') {
          return {
            v: 1,
            commandId: command.commandId,
            bindingId: command.bindingId,
            generation,
            requestedVersion: command.expectedPolicyVersion + 1,
            effectiveVersion,
            connectorState: 'rejected',
            errorCode: 'forbidden',
          };
        }
        // The connector has accepted the request but has not yet applied it, so
        // `connectorState` is honestly `pending` here — `decodePolicyAck`
        // requires `effectiveVersion === requestedVersion` whenever a command
        // claims `effective`, which is not true until the snapshot below lands.
        // KTD2: an ack alone never carries mode/paused, so the "requested"
        // badge — not the effective badge — is what this ack can move.
        const ack: PolicyAck = {
          v: 1,
          commandId: command.commandId,
          bindingId: command.bindingId,
          generation,
          requestedVersion: command.expectedPolicyVersion + 1,
          effectiveVersion,
          connectorState: 'pending',
          errorCode: null,
        };
        setTimeout(() => {
          effectiveVersion = command.expectedPolicyVersion + 1;
          paused = command.paused;
          notify(state);
        }, 600);
        return ack;
      },
      // Same compare-and-set rule as the listening-mode store: a stale
      // `expectedVersion` is a conflict, never a silent overwrite.
      submitListeningMode: async command => {
        await delay(100);
        state.modeSubmits += 1;
        const listening = state.listening;
        const base = { v: 1 as const, commandId: command.commandId, bindingId: command.bindingId, generation };
        if (command.expectedVersion !== listening.version) {
          notify(state);
          return {
            ...base, outcome: 'conflict', version: listening.version, requested: listening.requested,
            effective: effectiveOf(listening), reason: 'stale_version',
          };
        }
        listening.requested = command.requested;
        listening.version += 1;
        listening.lastChange = { actor: 'owner', version: listening.version, changedAt: command.issuedAt };
        notify(state);
        return {
          ...base, outcome: 'applied', version: listening.version, requested: listening.requested,
          effective: effectiveOf(listening), reason: null,
        };
      },
      submitRouteGrant: async command => {
        await delay(100);
        const listening = state.listening;
        if (command.expectedVersion !== listening.version) {
          return { commandId: command.commandId, outcome: 'conflict', reason: 'stale_version' };
        }
        const kind = command.kind.endsWith('experimental_route') ? 'experimental_route' : 'hard_cancel';
        const field = kind === 'experimental_route' ? 'experimentalGrants' : 'hardCancelGrants';
        const kept = listening[field].filter(grant => grant.mode !== command.mode || grant.route !== command.route);
        listening[field] = command.kind.startsWith('grant_')
          ? [...kept, {
            v: 1, kind, bindingId: command.bindingId, generation, mode: command.mode, route: command.route,
            harnessVersion: command.harnessVersion, evidenceRevision: command.evidenceRevision,
            grantRevision: command.expectedVersion + 1,
          }]
          : kept;
        listening.version += 1;
        return { commandId: command.commandId, outcome: 'applied', reason: null };
      },
    },
  };
}

const SHOW_SECOND = new URLSearchParams(window.location.search).has('second');
const ports = portsFor(primary);
const secondPorts = portsFor(second);

/** The bound agent changes its own mode; the push to this tab is delayed, so the next owner write is stale. */
function simulateAgentChange() {
  const listening = primary.listening;
  listening.requested = 'steer';
  listening.version += 1;
  listening.lastChange = { actor: 'agent', version: listening.version, changedAt: new Date().toISOString() };
}

function simulateDisconnect() {
  primary.connection = 'offline';
  notify(primary);
}

function logIncoming(text: string) {
  const log = document.getElementById('incoming-log')!;
  log.textContent = text;
}

function Harness() {
  const [incomingText, setIncomingText] = useState('');
  return (
    <>
      {/*
        This input demonstrates the structural guarantee under test: its
        content is only ever logged for display, never passed to the
        controller or the panel — there is no prop or code path by which
        incoming message text could reach a policy control.
      */}
      <label>
        Simulate incoming message text
        <input
          aria-label="Simulate incoming message text"
          value={incomingText}
          onChange={event => setIncomingText(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => logIncoming(incomingText)}
      >
        Post simulated message
      </button>
      <button type="button" onClick={simulateAgentChange}>Simulate agent mode change</button>
      <button type="button" onClick={simulateDisconnect}>Simulate disconnect</button>
      <output id="mode-submits">0</output>
      <div id="primary-panel">
        <AgentControlsPanel ports={ports} config={CONFIG} />
      </div>
      {/* A second concurrent session of the same CLI, only for the listening scenario. */}
      {SHOW_SECOND ? (
        <div id="second-panel">
          <AgentControlsPanel ports={secondPorts} config={SECOND_CONFIG} />
        </div>
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
