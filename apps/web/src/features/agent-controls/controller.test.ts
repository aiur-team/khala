import { describe, expect, it, vi } from 'vitest';
import type {
  BindingId, CommandId, ParticipantId, PolicyAck, RoomId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import { createAgentControlsController } from './controller';
import type { AgentControlsConfig } from './controller';
import type { AgentControlsPorts, AgentControlsSnapshot, PolicySnapshot } from './ports';

const BINDING_ID = 'bind-b-1' as BindingId;
const ROOM_ID = 'room-1' as RoomId;
const PEER_ID = 'agent-a' as ParticipantId;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: ROOM_ID,
  peerParticipantId: PEER_ID,
  ownerLabel: 'owner-b',
  agentLabel: 'agent-a',
  roomLabel: 'room-1',
};

const BINDING: SessionBinding = {
  v: 1,
  bindingId: BINDING_ID,
  ownerId: 'owner-b' as never,
  agentParticipantId: 'agent-b' as never,
  deviceId: 'dev-b' as never,
  harness: 'codex',
  sessionId: 'thread-existing-b',
  generation: 0,
};

const LIMITS = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

function policy(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    bindingId: BINDING_ID,
    generation: 0,
    effectiveVersion: 3,
    effectiveMode: 'review',
    paused: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AgentControlsSnapshot> = {}): AgentControlsSnapshot {
  return {
    binding: BINDING,
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
      limits: LIMITS,
      evidenceRef: 'evidence-1',
    },
    policy: policy(),
    connection: 'connected',
    latestReceipt: null,
    ...overrides,
  };
}

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {});
}

type Listener = (snapshot: AgentControlsSnapshot) => void;

function fakePorts(overrides: Readonly<{
  readSnapshot?: () => Promise<AgentControlsSnapshot>;
  submitPolicy?: () => Promise<PolicyAck>;
}> = {}): { ports: AgentControlsPorts; emit: Listener; submitPolicy: ReturnType<typeof vi.fn> } {
  let listener: Listener | null = null;
  const submitPolicy = vi.fn(overrides.submitPolicy ?? (() => pendingPromise<PolicyAck>()));
  const ports: AgentControlsPorts = {
    agentControls: {
      readSnapshot: overrides.readSnapshot ?? (() => pendingPromise<AgentControlsSnapshot>()),
      subscribe: (_bindingId, cb) => {
        listener = cb;
        const disposer: Disposer = () => {
          if (listener === cb) listener = null;
        };
        return disposer;
      },
      submitPolicy,
    },
  };
  return {
    ports,
    emit: s => listener?.(s),
    submitPolicy,
  };
}

describe('createAgentControlsController — initial state', () => {
  it('starts with controls unavailable and no authoritative snapshot', () => {
    const { ports } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(false);
    expect(view.policy.effectiveVersion).toBeNull();
    expect(view.connection).toBe('unknown');
    controller.dispose();
  });

  it('adopts a pushed snapshot and enables controls once an authoritative version arrives', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(true);
    expect(view.policy.effectiveVersion).toBe(3);
    expect(view.policy.effectiveMode).toBe('review');
    expect(view.policy.paused).toBe(false);
    controller.dispose();
  });

  it('never coerces a null effective version to zero', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({ policy: policy({ effectiveVersion: null, effectiveMode: null, paused: null }) }));
    const view = controller.getView();
    expect(view.policy.effectiveVersion).toBeNull();
    expect(view.controlsAvailable).toBe(false);
    controller.dispose();
  });
});

describe('createAgentControlsController — requestPause', () => {
  it('is a no-op while controls are unavailable', () => {
    const { ports, submitPolicy } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    controller.requestPause(true);
    expect(submitPolicy).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('marks the request pending immediately and keeps the mode "review" only, never "auto"', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    const view = controller.getView();
    expect(view.policy.requestedMode).toBe('review');
    expect(view.policy.requestedVersion).toBe(4);
    expect(view.policy.acknowledgment).toBe('pending');
    controller.dispose();
  });

  it('AE1: an offline ack leaves the prior effective mode visible and does not claim delivery stopped', () => {
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) =>
      Promise.resolve<PolicyAck>({
        v: 1, commandId: command.commandId, bindingId: BINDING_ID, generation: 0,
        requestedVersion: 4, effectiveVersion: 3, connectorState: 'offline', errorCode: null,
      });
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        const view = controller.getView();
        expect(view.policy.effectiveVersion).toBe(3);
        expect(view.policy.effectiveMode).toBe('review');
        expect(view.policy.acknowledgment).toBe('offline');
        controller.dispose();
        resolve();
      }, 0);
    });
  });

  it('rejects a stale ack: a superseded request cannot overwrite the winning snapshot', async () => {
    let resolveFirst: ((ack: PolicyAck) => void) | null = null;
    const firstAck = new Promise<PolicyAck>(resolve => {
      resolveFirst = resolve;
    });
    const submitPolicy = vi.fn()
      .mockImplementationOnce(() => firstAck)
      .mockImplementationOnce(() => Promise.resolve<PolicyAck>({
        v: 1, commandId: 'second-command' as CommandId, bindingId: BINDING_ID, generation: 0,
        requestedVersion: 4, effectiveVersion: 3, connectorState: 'pending', errorCode: null,
      }));
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = submitPolicy;

    let calls = 0;
    const createId = () => (calls++ === 0 ? 'first-command' : 'second-command');
    const controller = createAgentControlsController(ports, CONFIG, { createId });
    emit(snapshot());
    controller.requestPause(true);
    controller.requestPause(false);

    // The first (now-superseded) request resolves as "effective" after the
    // second request has already been issued — it must not win.
    resolveFirst!({
      v: 1, commandId: 'first-command' as CommandId, bindingId: BINDING_ID, generation: 0,
      requestedVersion: 4, effectiveVersion: 3, connectorState: 'effective', errorCode: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(submitPolicy).toHaveBeenCalledTimes(2);
    expect(controller.getView().policy.acknowledgment).toBe('pending');
    controller.dispose();
  });

  it('binding replacement clears pending controls and discards old acknowledgments', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    expect(controller.getView().policy.requestedMode).toBe('review');

    emit(snapshot({ policy: policy({ generation: 1, effectiveVersion: 1, paused: false }) }));
    const view = controller.getView();
    expect(view.policy.requestedMode).toBeNull();
    expect(view.policy.requestedVersion).toBeNull();
    expect(view.policy.effectiveVersion).toBe(1);
    controller.dispose();
  });

  it('a matching effective snapshot resolves the pending request to "effective"', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
    const view = controller.getView();
    expect(view.policy.acknowledgment).toBe('effective');
    expect(view.policy.requestedMode).toBeNull();
    expect(view.policy.paused).toBe(true);
    controller.dispose();
  });
});
