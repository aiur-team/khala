import { describe, expect, it, vi } from 'vitest';
import type {
  BindingId, CommandId, OwnerId, ParticipantId, PolicyAck, RoomId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits, unknownModeSupportMap } from '@khala/contracts/delivery/index';
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
const MODES = unknownModeSupportMap('test-codex-interactive', 'Test fixture has no primary mode proof.', '1.0.0');

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
      v: 3,
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
      modes: MODES,
      acknowledgement: 'unknown',
    },
    policy: policy(),
    connection: 'connected',
    latestReceipt: null,
    listening: null,
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
      submitListeningMode: () => pendingPromise(),
      submitRouteGrant: () => pendingPromise(),
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
        v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1.0.0', support: 'unsupported',
        existingSession: 'unknown', immediateNotification: 'unknown', busy: 'unknown', receiptEvidence: [],
        reconcileByReleaseId: 'unknown', limits: LIMITS, evidenceRef: null, modes: MODES, acknowledgement: 'unknown',
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
        v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1.0.0', support: 'tested',
        existingSession: 'unsupported', immediateNotification: 'unknown', busy: 'unknown', receiptEvidence: [],
        reconcileByReleaseId: 'unknown', limits: LIMITS, evidenceRef: 'evidence-1', modes: MODES, acknowledgement: 'unknown',
      },
    }));
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(false);
    controller.dispose();
  });

  it('never enables controls when existingSession is merely "unknown" (not investigated), only for the evidenced khala_hosted_resume route', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot({
      capabilities: {
        v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1.0.0', support: 'tested',
        existingSession: 'unknown', immediateNotification: 'unknown', busy: 'unknown', receiptEvidence: [],
        reconcileByReleaseId: 'unknown', limits: LIMITS, evidenceRef: 'evidence-1', modes: MODES, acknowledgement: 'unknown',
      },
    }));
    const view = controller.getView();
    expect(view.controlsAvailable).toBe(false);
    expect(view.capabilityDetail).toBe('Harness support: tested · Existing session: unknown');
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
    expect(view.ownerLabel).toBe("Another person's agent (#owner-z)");
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

  it('disables controls after a rejected ack, and a refreshed snapshot re-enables them for retry', () => {
    const { ports, emit } = fakePorts({ readSnapshot: () => Promise.resolve(snapshot()) });
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
        const rejectedView = controller.getView();
        expect(rejectedView.controlsAvailable).toBe(false);
        expect(rejectedView.unavailableReason).toMatch(/refresh/i);
        // The rejected request's identity must survive being disabled (AE2).
        expect(rejectedView.policy.requestedVersion).toBe(4);

        controller.refresh();
        setTimeout(() => {
          const refreshedView = controller.getView();
          expect(refreshedView.controlsAvailable).toBe(true);
          // The request-failed notice must actually clear on refresh, not
          // just the disable flag underlying it.
          expect(refreshedView.notice).toBeNull();
          controller.dispose();
          resolve();
        }, 0);
      }, 0);
    });
  });

  it('AE2: a network failure shows outcome unknown, never "offline", and preserves requested identity for a later retry', () => {
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
        expect(view.controlsAvailable).toBe(false);
        controller.dispose();
        resolve();
      }, 0);
    });
  });

  it('surfaces a readSnapshot failure as a dismissable notice instead of leaving the view silently stuck', () => {
    const { ports } = fakePorts({ readSnapshot: () => Promise.reject(new Error('network down')) });
    const controller = createAgentControlsController(ports, CONFIG);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        const view = controller.getView();
        expect(view.notice).toEqual({
          kind: 'snapshot-error',
          message: 'Could not load the current policy. Refresh to try again.',
        });
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
      requestedVersion: 4, effectiveVersion: 4, connectorState: 'effective', errorCode: null,
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
    expect(view.policy.acknowledgment).not.toBe('matches');
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

  it('a matching effective snapshot resolves the pending request to the tentative "matches" state, never "effective"/"confirmed"', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
    const view = controller.getView();
    expect(view.policy.acknowledgment).toBe('matches');
    expect(view.policy.requestedVersion).toBe(4);
    expect(view.policy.paused).toBe(true);
    controller.dispose();
  });

  it('a snapshot matching version/generation/paused but reporting "auto" mode does not confirm a review request', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true, effectiveMode: 'auto' }) }));
    const view = controller.getView();
    expect(view.policy.acknowledgment).not.toBe('matches');
    expect(view.policy.acknowledgment).not.toBe('effective');
    controller.dispose();
  });

  it('a snapshot matching paused but at the wrong version does not confirm the request', () => {
    const { ports, emit } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    emit(snapshot({ policy: policy({ effectiveVersion: 5, paused: true }) }));
    const view = controller.getView();
    expect(view.policy.acknowledgment).not.toBe('matches');
    expect(view.policy.acknowledgment).not.toBe('effective');
    controller.dispose();
  });

  it('a rejected ack overrides a coincidentally matching snapshot instead of being dropped as stale (blocker 4)', async () => {
    let resolveAck: ((ack: PolicyAck) => void) | null = null;
    let capturedCommandId: CommandId | null = null;
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) => {
      capturedCommandId = command.commandId;
      return new Promise<PolicyAck>(resolve => {
        resolveAck = resolve;
      });
    };
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);

    // Another actor's command reaches the exact same next version/mode/paused
    // before this command's own ack resolves — shown as a tentative
    // "matches" (the offline/pending reconciliation path), not a proven
    // "effective"/"confirmed".
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
    expect(controller.getView().policy.acknowledgment).toBe('matches');

    // This command's own outcome was actually a rejection. It must still be
    // applied and override the tentative "effective" — not get dropped as
    // superseded merely because the values-only match already looked settled.
    resolveAck!({
      v: 1, commandId: capturedCommandId!, bindingId: BINDING_ID, generation: 0,
      requestedVersion: 4, effectiveVersion: 3, connectorState: 'rejected', errorCode: 'stale_policy',
    });
    await Promise.resolve();
    await Promise.resolve();

    const view = controller.getView();
    expect(view.policy.acknowledgment).toBe('rejected');
    expect(view.policy.errorCode).toBe('stale_policy');
    controller.dispose();
  });

  it('a snapshot matching an already-rejected request\'s values does not flip it back to "effective"', () => {
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
        expect(controller.getView().policy.acknowledgment).toBe('rejected');
        // A later snapshot happens to match this request's original target
        // values (e.g. another actor made the same change independently) — it
        // must not resurrect this already-settled rejection as "effective".
        emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
        expect(controller.getView().policy.acknowledgment).toBe('rejected');
        controller.dispose();
        resolve();
      }, 0);
    });
  });

  it('a subsequent request targets this command\'s own confirmed effective version when it is newer than the latest snapshot, not the stale snapshot version', async () => {
    let resolveAck: ((ack: PolicyAck) => void) | null = null;
    let capturedCommandId: CommandId | null = null;
    const submitPolicy = vi.fn((command: { commandId: CommandId }) => {
      capturedCommandId = command.commandId;
      return new Promise<PolicyAck>(resolve => {
        resolveAck = resolve;
      });
    });
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = submitPolicy;
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot()); // effectiveVersion: 3
    controller.requestPause(true);

    // This command's own ack resolves "effective" for v4 before the v4
    // snapshot push arrives — `latestSnapshot` is still stuck at v3.
    resolveAck!({
      v: 1, commandId: capturedCommandId!, bindingId: BINDING_ID, generation: 0,
      requestedVersion: 4, effectiveVersion: 4, connectorState: 'effective', errorCode: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getView().policy.acknowledgment).toBe('effective');

    // The next request must target v4 (this command's own confirmed version),
    // not v3 from the stale snapshot — a v3-based request is guaranteed a
    // stale_policy rejection.
    controller.requestPause(false);
    expect(submitPolicy).toHaveBeenCalledTimes(2);
    const secondCommand = submitPolicy.mock.calls[1]![0] as unknown as { expectedPolicyVersion: number };
    expect(secondCommand.expectedPolicyVersion).toBe(4);
    controller.dispose();
  });

  it('retry() resends the failed request\'s exact commandId and expectedPolicyVersion, not a new command', () => {
    const submitPolicy = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('network down')))
      .mockImplementationOnce((command: { commandId: CommandId }) => Promise.resolve<PolicyAck>({
        v: 1, commandId: command.commandId, bindingId: BINDING_ID, generation: 0,
        requestedVersion: 4, effectiveVersion: 4, connectorState: 'effective', errorCode: null,
      }));
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = submitPolicy;
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(controller.getView().retryAvailable).toBe(true);
        expect(controller.getView().policy.acknowledgment).toBe('unknown');
        controller.retry();
        setTimeout(() => {
          expect(submitPolicy).toHaveBeenCalledTimes(2);
          const [[firstCommand], [secondCommand]] = submitPolicy.mock.calls as [
            [{ commandId: CommandId; expectedPolicyVersion: number }],
            [{ commandId: CommandId; expectedPolicyVersion: number }],
          ];
          expect(secondCommand.commandId).toBe(firstCommand.commandId);
          expect(secondCommand.expectedPolicyVersion).toBe(firstCommand.expectedPolicyVersion);
          expect(controller.getView().policy.acknowledgment).toBe('effective');
          expect(controller.getView().retryAvailable).toBe(false);
          controller.dispose();
          resolve();
        }, 0);
      }, 0);
    });
  });

  it('retry() is a no-op when there is no failed request to resend', () => {
    const { ports, emit, submitPolicy } = fakePorts();
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.retry();
    expect(submitPolicy).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('a late "effective" ack for a superseded version never rolls the effective display backward, and the next request targets the snapshot version, not the stale ack version', async () => {
    let resolveAck: ((ack: PolicyAck) => void) | null = null;
    let capturedCommandId: CommandId | null = null;
    const submitPolicy = vi.fn((command: { commandId: CommandId }) => {
      capturedCommandId = command.commandId;
      return new Promise<PolicyAck>(resolve => {
        resolveAck = resolve;
      });
    });
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = submitPolicy;
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);

    // A newer authoritative snapshot (v5, unpaused) arrives from elsewhere
    // before this command's own v4 ack resolves.
    emit(snapshot({ policy: policy({ effectiveVersion: 5, paused: false }) }));
    expect(controller.getView().policy.effectiveVersion).toBe(5);

    // This command's own ack now resolves "effective" for its (now stale) v4.
    resolveAck!({
      v: 1, commandId: capturedCommandId!, bindingId: BINDING_ID, generation: 0,
      requestedVersion: 4, effectiveVersion: 4, connectorState: 'effective', errorCode: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    const view = controller.getView();
    // The display must not roll back to the stale ack's v4.
    expect(view.policy.effectiveVersion).toBe(5);
    expect(view.policy.paused).toBe(false);

    // A subsequent request must target the current snapshot version (5), not
    // the version the stale ack tried to write (4) — a v4-based request would
    // be guaranteed a stale_policy rejection.
    controller.requestPause(true);
    expect(submitPolicy).toHaveBeenCalledTimes(2);
    const secondCommand = submitPolicy.mock.calls[1]![0] as unknown as { expectedPolicyVersion: number };
    expect(secondCommand.expectedPolicyVersion).toBe(5);
    controller.dispose();
  });

  it('clears a confirmed request\'s fields once a newer snapshot supersedes it, instead of showing a stale "confirmed" label next to the newer effective version', async () => {
    let resolveAck: ((ack: PolicyAck) => void) | null = null;
    let capturedCommandId: CommandId | null = null;
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) => {
      capturedCommandId = command.commandId;
      return new Promise<PolicyAck>(resolve => {
        resolveAck = resolve;
      });
    };
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);

    // This command's own ack resolves "effective" for v4 before the v4/v5
    // snapshot catches up.
    resolveAck!({
      v: 1, commandId: capturedCommandId!, bindingId: BINDING_ID, generation: 0,
      requestedVersion: 4, effectiveVersion: 4, connectorState: 'effective', errorCode: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getView().policy.acknowledgment).toBe('effective');
    expect(controller.getView().policy.requestedVersion).toBe(4);

    // A newer snapshot (v5) arrives from elsewhere — this command's "confirmed"
    // v4 request is now stale relative to the current effective version.
    emit(snapshot({ policy: policy({ effectiveVersion: 5, paused: true }) }));

    const view = controller.getView();
    expect(view.policy.effectiveVersion).toBe(5);
    expect(view.policy.requestedVersion).toBeNull();
    expect(view.policy.requestedMode).toBeNull();
    expect(view.policy.requestedPaused).toBeNull();
    expect(view.policy.errorCode).toBeNull();
    controller.dispose();
  });

  it('a late "pending"/"offline" ack for a command already tentatively "matches" does not downgrade the display', async () => {
    let resolveAck: ((ack: PolicyAck) => void) | null = null;
    let capturedCommandId: CommandId | null = null;
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) => {
      capturedCommandId = command.commandId;
      return new Promise<PolicyAck>(resolve => {
        resolveAck = resolve;
      });
    };
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);

    // A values-only snapshot match already shows this request as "matches".
    emit(snapshot({ policy: policy({ effectiveVersion: 4, paused: true }) }));
    expect(controller.getView().policy.acknowledgment).toBe('matches');

    // This command's own ack now resolves, but only as "offline" — stale
    // relative to the reconciliation the snapshot already provided.
    resolveAck!({
      v: 1, commandId: capturedCommandId!, bindingId: BINDING_ID, generation: 0,
      requestedVersion: 4, effectiveVersion: 3, connectorState: 'offline', errorCode: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getView().policy.acknowledgment).toBe('matches');
    controller.dispose();
  });

  it('carries errorCode on a non-rejected ack (e.g. "offline"), not only for a rejected one', async () => {
    let capturedCommandId: CommandId | null = null;
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) => {
      capturedCommandId = command.commandId;
      return Promise.resolve<PolicyAck>({
        v: 1, commandId: command.commandId, bindingId: BINDING_ID, generation: 0,
        requestedVersion: 4, effectiveVersion: 3, connectorState: 'offline', errorCode: 'forbidden',
      });
    };
    const controller = createAgentControlsController(ports, CONFIG);
    emit(snapshot());
    controller.requestPause(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(capturedCommandId).not.toBeNull();
    expect(controller.getView().policy.acknowledgment).toBe('offline');
    expect(controller.getView().policy.errorCode).toBe('forbidden');
    controller.dispose();
  });

  it('clears the receipt detail on a binding-generation change instead of carrying it from the superseded generation', () => {
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

    emit(snapshot({ policy: policy({ generation: 1, effectiveVersion: 1, paused: false }) }));
    expect(controller.getView().receiptDetail).toBeNull();
    controller.dispose();
  });

  it('discards an ack whose generation does not match the current binding generation', () => {
    const { ports, emit } = fakePorts();
    (ports.agentControls as { submitPolicy: unknown }).submitPolicy = (command: { commandId: CommandId }) =>
      Promise.resolve<PolicyAck>({
        v: 1, commandId: command.commandId, bindingId: BINDING_ID, generation: 99,
        requestedVersion: 4, effectiveVersion: 4, connectorState: 'effective', errorCode: null,
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
