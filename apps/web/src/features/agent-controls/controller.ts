import type {
  BindingId, CommandId, ParticipantId, PolicyAck, PolicySetCommand, RoomId,
} from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import { initialAgentControlsView, type AgentControlsView } from './model';
import type { AgentControlsPorts, AgentControlsSnapshot } from './ports';

export interface AgentControlsController {
  getView(): AgentControlsView;
  subscribe(listener: (view: AgentControlsView) => void): Disposer;
  /**
   * Requests a pause on future automatic delivery under the current review
   * policy. This is a delivery-policy request, never cancellation of a model
   * turn already in flight — the receipt vocabulary's `cancel_requested`/
   * `cancelled` kinds describe delivery, not the harness turn (KTD3).
   */
  requestPause(paused: boolean): void;
  dispose(): void;
}

export interface AgentControlsConfig {
  readonly bindingId: BindingId;
  readonly roomId: RoomId;
  readonly peerParticipantId: ParticipantId;
  readonly ownerLabel: string;
  readonly agentLabel: string;
  readonly roomLabel: string;
}

const defaultCreateId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

type PendingCommand = Readonly<{
  commandId: CommandId;
  expectedPolicyVersion: number;
  expectedNextVersion: number;
  expectedGeneration: number;
}>;

function unavailableReason(snapshot: AgentControlsSnapshot | null): string | null {
  if (snapshot === null) return 'Waiting for an authoritative snapshot.';
  if (snapshot.capabilities === null) return 'Waiting for harness capabilities.';
  if (snapshot.capabilities.support === 'unsupported') return 'This harness is not supported for delivery controls.';
  if (snapshot.policy.effectiveVersion === null) return 'Waiting for an authoritative policy snapshot.';
  return null;
}

export function createAgentControlsController(
  ports: AgentControlsPorts,
  config: AgentControlsConfig,
  options: Readonly<{ createId?: () => string }> = {},
): AgentControlsController {
  const createId = options.createId ?? defaultCreateId;
  const port = ports.agentControls;

  let disposed = false;
  let view: AgentControlsView = initialAgentControlsView(config);
  let latestSnapshot: AgentControlsSnapshot | null = null;
  let pendingCommand: PendingCommand | null = null;
  let latestCommandId: string | null = null;
  const listeners = new Set<(view: AgentControlsView) => void>();
  let portDisposer: Disposer | null = null;

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener(view);
  }

  function connectionFrom(snapshot: AgentControlsSnapshot): AgentControlsView['connection'] {
    return snapshot.connection;
  }

  /**
   * Applies a fresh authoritative snapshot. A generation change means the
   * binding was replaced — old pending state and acknowledgments are cleared
   * and never inherited, since permissive policy from a superseded binding
   * must not silently carry forward (Technical decisions, plan KTD1).
   */
  function applySnapshot(snapshot: AgentControlsSnapshot): void {
    latestSnapshot = snapshot;
    const generationChanged = pendingCommand !== null
      && pendingCommand.expectedGeneration !== snapshot.policy.generation;

    if (generationChanged) {
      pendingCommand = null;
      latestCommandId = null;
    }

    const reachedRequested = pendingCommand !== null
      && snapshot.policy.effectiveVersion === pendingCommand.expectedNextVersion
      && snapshot.policy.generation === pendingCommand.expectedGeneration;

    const nextAcknowledgment: AgentControlsView['policy']['acknowledgment'] = generationChanged
      ? 'pending'
      : reachedRequested
        ? 'effective'
        : view.policy.acknowledgment;

    if (reachedRequested) {
      pendingCommand = null;
      latestCommandId = null;
    }

    view = {
      ...view,
      connection: connectionFrom(snapshot),
      controlsAvailable: unavailableReason(snapshot) === null,
      unavailableReason: unavailableReason(snapshot),
      receiptDetail: view.receiptDetail,
      policy: {
        ...view.policy,
        effectiveMode: snapshot.policy.effectiveMode,
        effectiveVersion: snapshot.policy.effectiveVersion,
        paused: snapshot.policy.paused,
        acknowledgment: nextAcknowledgment,
        ...(pendingCommand === null ? { requestedMode: null, requestedVersion: null } : {}),
      },
    };
    notify();
  }

  function applyAck(command: PendingCommand, ack: PolicyAck): void {
    // A response for a superseded request (a newer command was issued while
    // this one was in flight) must never overwrite the winning state.
    if (latestCommandId !== command.commandId) return;
    if (ack.commandId !== command.commandId) return;
    if (latestSnapshot !== null && ack.bindingId !== latestSnapshot.binding.bindingId) return;
    if (latestSnapshot !== null && ack.generation !== latestSnapshot.policy.generation) return;

    view = {
      ...view,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: ack.requestedVersion,
        acknowledgment: ack.connectorState,
      },
    };
    notify();
  }

  function requestPause(paused: boolean): void {
    if (disposed) return;
    if (!view.controlsAvailable) return;
    const expectedPolicyVersion = view.policy.effectiveVersion;
    if (expectedPolicyVersion === null) return;

    const commandId = createId() as CommandId;
    const command: PendingCommand = {
      commandId,
      expectedPolicyVersion,
      expectedNextVersion: expectedPolicyVersion + 1,
      expectedGeneration: latestSnapshot?.policy.generation ?? 0,
    };
    pendingCommand = command;
    latestCommandId = commandId;

    view = {
      ...view,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: command.expectedNextVersion,
        acknowledgment: 'pending',
      },
    };
    notify();

    const wireCommand: PolicySetCommand = {
      v: 1,
      commandId,
      roomId: config.roomId,
      bindingId: config.bindingId,
      peerParticipantId: config.peerParticipantId,
      expectedPolicyVersion: command.expectedPolicyVersion,
      expectedBindingGeneration: command.expectedGeneration,
      mode: 'review',
      paused,
      issuedAt: new Date().toISOString(),
    };

    port.submitPolicy(wireCommand)
      .then(ack => applyAck(command, ack))
      .catch(() => applyAck(command, {
        v: 1,
        commandId,
        bindingId: config.bindingId,
        generation: command.expectedGeneration,
        requestedVersion: null,
        effectiveVersion: null,
        connectorState: 'offline',
        errorCode: 'unavailable',
      }));
  }

  port.readSnapshot(config.bindingId).then(snapshot => {
    if (!disposed) applySnapshot(snapshot);
  }).catch(() => undefined);
  portDisposer = port.subscribe(config.bindingId, snapshot => {
    if (!disposed) applySnapshot(snapshot);
  });

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestPause,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      portDisposer?.();
    },
  };
}
