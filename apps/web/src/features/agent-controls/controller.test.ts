import { describe, expect, it, vi } from 'vitest';
import type {
  BindingId, CommandId, OwnerId, ParticipantId, PolicyAck, RoomId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import { createAgentControlsController } from './controller';
import type { AgentControlsConfig } from './controller';
import type { AgentControlsPorts, AgentControlsSnapshot, PolicySnapshot } from './ports';

const BINDING_ID = 'bind-b-1' as BindingId;
const ROOM_ID = 'room-1' as RoomId;
const PEER_ID = 'agent-a' as ParticipantId;
const VIEWER_OWNER_ID = 'owner-b' as OwnerId;
const OTHER_OWNER_ID = 'owner-z' as OwnerId;

const CONFIG: AgentControlsConfig = {
  bindingId: BINDING_ID,
  roomId: ROOM_ID,
  peerParticipantId: PEER_ID,
  viewerOwnerId: VIEWER_OWNER_ID,
  agentLabel: 'agent-a',
  roomLabel: 'room-1',
};

const BINDING: SessionBinding = {
  v: 1,
  bindingId: BINDING_ID,
  ownerId: VIEWER_OWNER_ID,
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
    bindingStatus: 'active',
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

  it('never enables controls for a null capabilities snapshot', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({ capabilities: null }));
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(false);
    expect(view.unavailableReason).toMatch(/harness capabilities/i);
    controller.dispose();
  });

  it('never enables controls for an unsupported harness, and shows connection as unknown rather than online', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({
      capabilities: {
        v: 1, harness: 'codex', version: '1.0.0', adapterVersion: '1.0.0', support: 'unsupported',
        existingSession: 'unknown', immediateNotification: 'unknown', busy: 'unknown', receiptEvidence: [],
        reconcileByReleaseId: 'unknown', limits: LIMITS, evidenceRef: null,
      },
    }));
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(false);
    expect(view.connection).toBe('unknown');
    controller.dispose();
  });

  it('never enables controls when existingSession is unsupported for this harness', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({
      capabilities: {
        v: 1, harness: 'codex', version: '1.0.0', adapterVersion: '1.0.0', support: 'tested',
        existingSession: 'unsupported', immediateNotification: 'unknown', busy: 'unknown', receiptEvidence: [],
        reconcileByReleaseId: 'unknown', limits: LIMITS, evidenceRef: 'evidence-1',
      },
    }));
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(false);
    controller.dispose();
  });

  it('shows "Your agent" for a binding the viewer owns, and enables controls', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    const view = controller.getView();
    expect(view.ownerLabel).toBe('Your agent');
    expect(view.isViewerOwned).toBe(true);
    expect(view.controlsAvailable).toBe(true);
    controller.dispose();
  });

  it('never enables controls for a binding the viewer does not own', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({ binding: { ...BINDING, ownerId: OTHER_OWNER_ID } }));
    const view = controller.getView();
    expect(view.ownerLabel).toBe("Another person's agent (#er-z)");
    expect(view.isViewerOwned).toBe(false);
    expect(view.controlsAvailable).toBe(false);
    controller.dispose();
  });

  it('never enables controls for a revoked binding, and shows revoked in the view', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({ bindingStatus: 'revoked' }));
    const view = controller.getView();
    expect(view.revoked).toBe(true);
    expect(view.controlsAvailable).toBe(false);
    expect(view.unavailableReason).toMatch(/revoked/i);
    controller.dispose();
  });

  it('renders receipt facts from the snapshot using the closed-code labels', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({
      latestReceipt: {
        v: 1, receiptId: 'r-1' as never, releaseId: 'rel-1' as never, bindingId: BINDING_ID, generation: 0,
        kind: 'context_consumed', observedAt: '2026-09-18T00:00:00Z', source: 'harness', evidenceRef: null,
        errorCode: null,
      },
    }));
    expect(controller.getView().receiptDetail).toBe('Received by the model');
    controller.dispose();
  });

  it('ignores a snapshot reporting an older effective version than already displayed', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({ policy: policy({ effectiveVersion: 5 }) }));
    emit(snapshot({ policy: policy({ effectiveVersion: 3 }) }));
    expect(controller.getView().policy.effectiveVersion).toBe(5);
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

  it('sends the exact wire command: mode is always "review", never "auto"', () => {
    const { ports, emit, submitPolicy } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    expect(submitPolicy).toHaveBeenCalledTimes(1);
    const sent = submitPolicy.mock.calls[0]![0];
    expect(sent).toMatchObject({
      v: 1,
      roomId: ROOM_ID,
      bindingId: BINDING_ID,
      peerParticipantId: PEER_ID,
      expectedPolicyVersion: 3,
      expectedBindingGeneration: 0,
      mode: 'review',
      paused: true,
    });
    expect(sent.mode).not.toBe('auto');
    controller.dispose();
  });

  it('marks the request pending immediately, tracking the requested paused value', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    const view = controller.getView();
    expect(view.policy.requestedMode).toBe('review');
    expect(view.policy.requestedVersion).toBe(4);
    expect(view.policy.requestedPaused).toBe(true);
    expect(view.policy.acknowledgment).toBe('pending');
    controller.dispose();
  });

  it('a resume request is tracked as requestedPaused: false, distinct from a pause request', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({ policy: policy({ paused: true }) }));
    controller.requestPause(false);
    expect(controller.getView().policy.requestedPaused).toBe(false);
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
        expect(view.policy.requestedVersion).toBe(4);
        controller.dispose();
        resolve();
      }, 0);
    });
  });

  it('AE2: a rejected ack keeps the requested version and surfaces the error code, instead of erasing the request', () => {
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) =>
      Promise.resolve<PolicyAck>({
        v: 1, commandId: command.commandId, bindingId: BINDING_ID, generation: 0,
        requestedVersion: 4, effectiveVersion: 3, connectorState: 'rejected', errorCode: 'stale_policy',
      });
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        const view = controller.getView();
        expect(view.policy.acknowledgment).toBe('rejected');
        expect(view.policy.requestedVersion).toBe(4);
        expect(view.policy.errorCode).toBe('stale_policy');
        expect(view.notice).not.toBeNull();
        controller.dispose();
        resolve();
      }, 0);
    });
  });

  it('AE2: a network failure shows outcome unknown, never "offline", and keeps operation identity for retry', () => {
    const { ports, emit } = fakePorts({ submitPolicy: () => Promise.reject(new Error('network down')) });
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        const view = controller.getView();
        expect(view.policy.acknowledgment).toBe('unknown');
        expect(view.policy.acknowledgment).not.toBe('offline');
        expect(view.policy.requestedVersion).toBe(4);
        expect(view.policy.requestedPaused).toBe(true);
        expect(view.notice).not.toBeNull();
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

  it('a competing tab\'s coincidentally matching version cannot resolve this tab\'s different request as effective', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    // This tab requests a resume (paused: false)...
    controller.requestPause(false);
    // ...but another tab's competing command reaches the same next version
    // while requesting the opposite value (paused: true).
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
    const view = controller.getView();
    expect(view.policy.acknowledgment).not.toBe('effective');
    expect(view.policy.requestedPaused).toBe(false);
    controller.dispose();
  });

  it('binding replacement clears pending controls, discards old acknowledgments, and surfaces a binding-replaced notice', () => {
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
    expect(view.notice?.kind).toBe('binding-replaced');
    controller.dispose();
  });

  it('a matching effective snapshot resolves the pending request to "effective" and keeps the confirmation visible', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
    const view = controller.getView();
    expect(view.policy.acknowledgment).toBe('effective');
    expect(view.policy.requestedVersion).toBe(4);
    expect(view.policy.paused).toBe(true);
    controller.dispose();
  });

  it('discards an ack whose generation does not match the current binding generation', () => {
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) =>
      Promise.resolve<PolicyAck>({
        v: 1, commandId: command.commandId, bindingId: BINDING_ID, generation: 99,
        requestedVersion: 4, effectiveVersion: 3, connectorState: 'effective', errorCode: null,
      });
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(controller.getView().policy.acknowledgment).toBe('pending');
        controller.dispose();
        resolve();
      }, 0);
    });
  });
});

describe('createAgentControlsController — refresh', () => {
  it('re-reads the authoritative snapshot on demand', () => {
    let calls = 0;
    const { ports } = fakePorts({
      readSnapshot: () => {
        calls += 1;
        return calls === 1 ? pendingPromise<AgentControlsSnapshot>() : Promise.resolve(snapshot());
      },
    });
    const controller = createAgentControlsController(ports, CONFIG);
    expect(calls).toBe(1);
    controller.refresh();
    expect(calls).toBe(2);
    controller.dispose();
  });
});
