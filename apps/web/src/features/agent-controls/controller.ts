import type {
  BindingId, CommandId, OwnerId, ParticipantId, PolicyAck, PolicySetCommand, RoomId,
} from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import { initialAgentControlsView, ownerLabelFor, type AgentControlsView } from './model';
import { receiptLabel } from './receipt-labels';
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
  /** Re-reads the authoritative snapshot; used to recover from a failed request or a stale/replaced binding. */
  refresh(): void;
  dispose(): void;
}

export interface AgentControlsConfig {
  readonly bindingId: BindingId;
  readonly roomId: RoomId;
  readonly peerParticipantId: ParticipantId;
  readonly viewerOwnerId: OwnerId;
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
  requestedPaused: boolean;
}>;

function unavailableReason(snapshot: AgentControlsSnapshot | null, viewerOwnerId: OwnerId): string | null {
  if (snapshot === null) return 'Waiting for an authoritative snapshot.';
  if (snapshot.bindingStatus === 'revoked') return 'This binding has been revoked.';
  if (snapshot.binding.ownerId !== viewerOwnerId) return "This binding belongs to another person's agent connection.";
  if (snapshot.capabilities === null) return 'Waiting for harness capabilities.';
  if (snapshot.capabilities.support === 'unsupported') return 'This harness is not supported for delivery controls.';
  if (snapshot.capabilities.existingSession === 'unsupported') {
    return 'This connector does not support the existing session for this binding.';
  }
  if (snapshot.policy.effectiveVersion === null) return 'Waiting for an authoritative policy snapshot.';
  return null;
}

/** Honest connection display: a transport that is "connected" to a harness this build cannot use is not "online" in any actionable sense. */
function connectionFrom(snapshot: AgentControlsSnapshot): AgentControlsView['connection'] {
  if (snapshot.capabilities === null) return 'unknown';
  if (snapshot.capabilities.support === 'unsupported') return 'unknown';
  return snapshot.connection;
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

  /**
   * Applies a fresh authoritative snapshot. A generation change means the
   * binding was replaced — old pending state and acknowledgments are cleared
   * and never inherited, since permissive policy from a superseded binding
   * must not silently carry forward (Technical decisions, plan KTD1). Any
   * snapshot older than the version already displayed is ignored outright so
   * out-of-order delivery cannot roll the display backward.
   */
  function applySnapshot(snapshot: AgentControlsSnapshot): void {
    const generationChanged = latestSnapshot !== null
      && latestSnapshot.policy.generation !== snapshot.policy.generation;

    if (
      !generationChanged
      && latestSnapshot !== null
      && latestSnapshot.policy.effectiveVersion !== null
      && snapshot.policy.effectiveVersion !== null
      && snapshot.policy.effectiveVersion < latestSnapshot.policy.effectiveVersion
    ) {
      return;
    }

    latestSnapshot = snapshot;
    const hadPending = pendingCommand !== null;
    const pendingClearedByGeneration = hadPending
      && pendingCommand!.expectedGeneration !== snapshot.policy.generation;

    if (pendingClearedByGeneration) {
      pendingCommand = null;
      latestCommandId = null;
    }

    const reachedRequested = pendingCommand !== null
      && snapshot.policy.effectiveVersion === pendingCommand.expectedNextVersion
      && snapshot.policy.generation === pendingCommand.expectedGeneration
      && snapshot.policy.paused === pendingCommand.requestedPaused;

    const nextAcknowledgment: AgentControlsView['policy']['acknowledgment'] = pendingClearedByGeneration
      ? 'pending'
      : reachedRequested
        ? 'effective'
        : view.policy.acknowledgment;

    if (reachedRequested) {
      pendingCommand = null;
      latestCommandId = null;
    }

    const reason = unavailableReason(snapshot, config.viewerOwnerId);
    const isViewerOwned = snapshot.binding.ownerId === config.viewerOwnerId;

    view = {
      ...view,
      ownerLabel: ownerLabelFor(snapshot.binding.ownerId, config.viewerOwnerId),
      isViewerOwned,
      revoked: snapshot.bindingStatus === 'revoked',
      connection: connectionFrom(snapshot),
      controlsAvailable: reason === null,
      unavailableReason: reason,
      notice: pendingClearedByGeneration
        ? { kind: 'binding-replaced', message: 'This agent connection was replaced. Refresh to see the current policy.' }
        : generationChanged ? null : view.notice,
      receiptDetail: snapshot.latestReceipt ? receiptLabel(snapshot.latestReceipt) : view.receiptDetail,
      policy: {
        ...view.policy,
        effectiveMode: snapshot.policy.effectiveMode,
        effectiveVersion: snapshot.policy.effectiveVersion,
        paused: snapshot.policy.paused,
        acknowledgment: nextAcknowledgment,
        // A generation change discards the superseded request outright (never
        // inherited, KTD1). Reaching "effective" deliberately keeps the
        // requested fields populated — with `acknowledgment: 'effective'` —
        // rather than clearing them in the same update, so the confirmation
        // is actually visible (and announced via the permanently mounted
        // live region) instead of disappearing the instant it is true.
        ...(pendingClearedByGeneration
          ? { requestedMode: null, requestedVersion: null, requestedPaused: null, errorCode: null }
          : {}),
      },
    };
    notify();
  }

  /** A resolved ack for a superseded request — a newer command was issued while this one was in flight — must never overwrite the winning state. */
  function applyAck(command: PendingCommand, ack: PolicyAck): void {
    if (latestCommandId !== command.commandId) return;
    if (ack.commandId !== command.commandId) return;
    if (latestSnapshot !== null && ack.bindingId !== latestSnapshot.binding.bindingId) return;
    if (latestSnapshot !== null && ack.generation !== latestSnapshot.policy.generation) return;

    view = {
      ...view,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: command.expectedNextVersion,
        requestedPaused: command.requestedPaused,
        acknowledgment: ack.connectorState,
        errorCode: ack.errorCode,
      },
      notice: ack.connectorState === 'rejected'
        ? { kind: 'request-failed', message: 'The request was rejected. Refresh to see the current policy.' }
        : view.notice,
    };
    notify();
  }

  /** A network/transport failure never overwrites the request with a fabricated ack: the outcome is genuinely unknown, and the requested fields are preserved for retry (AE2). */
  function applySubmitFailure(command: PendingCommand): void {
    if (latestCommandId !== command.commandId) return;

    view = {
      ...view,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: command.expectedNextVersion,
        requestedPaused: command.requestedPaused,
        acknowledgment: 'unknown',
        errorCode: null,
      },
      notice: { kind: 'request-failed', message: 'Could not reach the connector. Refresh to see the current policy, or try again.' },
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
      requestedPaused: paused,
    };
    pendingCommand = command;
    latestCommandId = commandId;

    view = {
      ...view,
      notice: null,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: command.expectedNextVersion,
        requestedPaused: paused,
        acknowledgment: 'pending',
        errorCode: null,
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
      .catch(() => applySubmitFailure(command));
  }

  function readSnapshot(): void {
    port.readSnapshot(config.bindingId).then(snapshot => {
      if (!disposed) applySnapshot(snapshot);
    }).catch(() => {
      if (disposed) return;
      view = { ...view, notice: { kind: 'snapshot-error', message: 'Could not load the current policy. Refresh to try again.' } };
      notify();
    });
  }

  readSnapshot();
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
    refresh: readSnapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      portDisposer?.();
    },
  };
}
