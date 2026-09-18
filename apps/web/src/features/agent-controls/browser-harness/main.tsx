import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  BindingId, DeliveryLimits, ParticipantId, PolicyAck, RoomId,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { AgentControlsPanel } from '../AgentControlsPanel';
import type { AgentControlsConfig } from '../controller';
import type { AgentControlsPorts, AgentControlsSnapshot } from '../ports';

/**
 * Synthetic port for the browser harness only. No real harness sessions,
 * network calls, or connector credentials: every response is fabricated
 * in-memory, and `submitPolicy` is the only path that can ever change state.
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const BINDING_ID = 'bind_harness' as BindingId;
const ROOM_ID = 'room_harness' as RoomId;
const PEER_ID = 'agent_harness' as ParticipantId;

const limitsResult = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
if (!limitsResult.ok) throw new Error('invalid harness limits');
const limits: DeliveryLimits = limitsResult.value;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: ROOM_ID,
  peerParticipantId: PEER_ID,
  ownerLabel: 'owner-harness',
  agentLabel: 'agent-harness',
  roomLabel: 'room-harness',
};

const generation = 0;
let effectiveVersion = 3;
const effectiveMode: 'review' | 'auto' = 'review';
let paused = false;
let listeners: ((snapshot: AgentControlsSnapshot) => void)[] = [];

function currentSnapshot(): AgentControlsSnapshot {
  return {
    binding: {
      v: 1,
      bindingId: BINDING_ID,
      ownerId: 'owner_harness' as never,
      agentParticipantId: 'agent_harness' as never,
      deviceId: 'device_harness' as never,
      harness: 'codex',
      sessionId: 'thread_harness',
      generation,
    },
    capabilities: {
      v: 1,
      harness: 'codex',
      version: '1.0.0',
      adapterVersion: '1.0.0',
      support: 'tested',
      existingSession: 'khala_hosted_resume',
      immediateNotification: 'khala_hosted_idle',
      busy: 'queue',
      receiptEvidence: [],
      reconcileByReleaseId: 'while_queued',
      limits,
      evidenceRef: 'evidence_harness',
    },
    policy: { bindingId: BINDING_ID, generation, effectiveVersion, effectiveMode, paused },
    connection: 'connected',
    latestReceipt: null,
  };
}

function notify() {
  const snapshot = currentSnapshot();
  for (const listener of listeners) listener(snapshot);
}

const ports: AgentControlsPorts = {
  agentControls: {
    readSnapshot: async () => {
      await delay(50);
      return currentSnapshot();
    },
    subscribe: (_bindingId, listener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter(l => l !== listener);
      };
    },
    submitPolicy: async command => {
      await delay(150);
      const ack: PolicyAck = {
        v: 1,
        commandId: command.commandId,
        bindingId: command.bindingId,
        generation,
        requestedVersion: command.expectedPolicyVersion + 1,
        effectiveVersion,
        connectorState: 'effective',
        errorCode: null,
      };
      // The ack's connector acknowledgment lands before the authoritative
      // snapshot that actually updates the effective display (KTD2: an ack
      // alone never carries mode/paused) — this gap is deliberate so the
      // "requested" badge is observable before the snapshot confirms it.
      setTimeout(() => {
        effectiveVersion = command.expectedPolicyVersion + 1;
        paused = command.paused;
        notify();
      }, 600);
      return ack;
    },
  },
};

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
      <AgentControlsPanel ports={ports} config={CONFIG} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
