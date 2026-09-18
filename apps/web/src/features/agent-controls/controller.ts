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
   * Requests a pause (or resume) of future review delivery under the current
   * policy. This is a delivery-policy request, never cancellation of a model
   * turn already in flight — the receipt vocabulary's `cancel_requested`/
   * `cancelled` kinds describe delivery, not the harness turn (KTD3).
   */
  requestPause(paused: boolean): void;
  /** Re-reads the authoritative snapshot; used to recover from a failed request or a stale/replaced binding. */
  refresh(): void;
  /** Resends the last request that failed with a genuinely unknown outcome, reusing its commandId and expected version rather than starting a new one. */
  retry(): void;
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

function unavailableReason(
  snapshot: AgentControlsSnapshot | null,
  viewerOwnerId: OwnerId,
  hasActionFailure: boolean,
): string | null {
  if (snapshot === null) return 'Waiting for an authoritative snapshot.';
  if (snapshot.bindingStatus === 'revoked') return 'This binding has been revoked.';
  if (snapshot.binding.ownerId !== viewerOwnerId) return "This binding belongs to another person's agent connection.";
  if (snapshot.capabilities === null) return 'Waiting for harness capabilities.';
  if (snapshot.capabilities.support === 'unsupported') return 'This harness is not supported for delivery controls.';
  // Enable delivery controls only for the one evidence-backed existing-session
  // route (KTD3): `unknown` is "not investigated", not "safe to assume", so it
  // is treated the same as `unsupported` rather than left enabled by default.
  if (snapshot.capabilities.existingSession !== 'khala_hosted_resume') {
    return 'This connector does not support the existing session for this binding.';
  }
  if (snapshot.policy.effectiveVersion === null) return 'Waiting for an authoritative policy snapshot.';
  // A rejected request or an unreachable connector leaves the displayed policy
  // stale relative to what was asked for; the control stays disabled until a
  // fresh authoritative snapshot arrives (via push or an explicit refresh),
  // rather than allowing a second request to race the unresolved first one.
  if (hasActionFailure) return 'The last request could not be confirmed. Refresh to see the current policy before retrying.';
  return null;
}

/** Honest connection display: a transport that is "connected" to a harness this build cannot use is not "online" in any actionable sense. */
function connectionFrom(snapshot: AgentControlsSnapshot): AgentControlsView['connection'] {
  if (snapshot.capabilities === null) return 'unknown';
  if (snapshot.capabilities.support === 'unsupported') return 'unknown';
  return snapshot.connection;
}

/** Surfaces the exact inspected capability states driving `unavailableReason`, so a disabled control is explained rather than merely asserted. */
function capabilityDetailFor(snapshot: AgentControlsSnapshot): string | null {
  if (snapshot.capabilities === null) return null;
  return `Harness support: ${snapshot.capabilities.support} · Existing session: ${snapshot.capabilities.existingSession}`;
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
  let hasActionFailure = false;
  let lastFailedCommand: PendingCommand | null = null;
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
    // A fresh authoritative snapshot — whether pushed or fetched by an
    // explicit refresh — is the human's cue to retry, so it always clears a
    // prior unconfirmed-request disable rather than leaving it stuck forever.
    hasActionFailure = false;
    lastFailedCommand = null;
    const hadPending = pendingCommand !== null;
    const pendingClearedByGeneration = hadPending
      && pendingCommand!.expectedGeneration !== snapshot.policy.generation;

    if (pendingClearedByGeneration) {
      pendingCommand = null;
      latestCommandId = null;
    }

    // Values-only agreement (no command identity in the snapshot) is the
    // reconciliation path for a request whose own ack never resolved
    // decisively (offline/pending) — required for the offline-reconnect case
    // (plan state diagram). It is not proof that *this* command produced the
    // match, so it is rendered as the distinct `'matches'` state, never
    // `'effective'`/"confirmed" — that wording is reserved for this exact
    // command's own terminal ack (blocker: false "confirmed"). The command's
    // identity is kept alive rather than retired here: if this command's own
    // ack later arrives rejected, `applyAck` can still override this
    // tentative "matches" instead of the ack being dropped as stale
    // (blocker 4). `effectiveMode` is checked because a snapshot can
    // otherwise coincidentally match version/generation/paused while reporting
    // the unrelated `auto` mode this panel never requests.
    const reachedRequested = pendingCommand !== null
      && snapshot.policy.effectiveMode === 'review'
      && snapshot.policy.effectiveVersion === pendingCommand.expectedNextVersion
      && snapshot.policy.generation === pendingCommand.expectedGeneration
      && snapshot.policy.paused === pendingCommand.requestedPaused;

    const nextAcknowledgment: AgentControlsView['policy']['acknowledgment'] = pendingClearedByGeneration
      ? 'pending'
      : reachedRequested
        ? 'matches'
        : view.policy.acknowledgment;

    const reason = unavailableReason(snapshot, config.viewerOwnerId, hasActionFailure);
    const isViewerOwned = snapshot.binding.ownerId === config.viewerOwnerId;

    view = {
      ...view,
      ownerLabel: ownerLabelFor(snapshot.binding.ownerId, config.viewerOwnerId),
      isViewerOwned,
      revoked: snapshot.bindingStatus === 'revoked',
      connection: connectionFrom(snapshot),
      controlsAvailable: reason === null,
      unavailableReason: reason,
      capabilityDetail: capabilityDetailFor(snapshot),
      retryAvailable: false,
      notice: pendingClearedByGeneration
        ? { kind: 'binding-replaced', message: 'This agent connection was replaced. Refresh to see the current policy.' }
        // A new authoritative snapshot is the dismissal path for a request-failed
        // notice (model.ts: "dismiss-by-refresh") — the human asked to see the
        // current truth, so a stale failure notice does not linger past it.
        : generationChanged || view.notice?.kind === 'request-failed' ? null : view.notice,
      receiptDetail: generationChanged
        ? null
        : snapshot.latestReceipt ? receiptLabel(snapshot.latestReceipt) : view.receiptDetail,
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

  /**
   * A resolved ack for a superseded request — a newer command was issued while
   * this one was in flight — must never overwrite the winning state.
   * `effective`/`rejected` are the two connector-decided terminal outcomes for
   * this exact command (KTD1/blocker 4): once either arrives, this command's
   * identity is retired here — never earlier by a coincidental values-only
   * snapshot match — so a late-arriving rejection can still override a
   * tentative "effective" shown from `applySnapshot`, rather than being
   * dropped as stale (blocker 4). `pending`/`offline` are not decided by this
   * ack alone and leave the command's identity live for that reconciliation.
   */
  function applyAck(command: PendingCommand, ack: PolicyAck): void {
    if (latestCommandId !== command.commandId) return;
    if (ack.commandId !== command.commandId) return;
    if (latestSnapshot !== null && ack.bindingId !== latestSnapshot.binding.bindingId) return;
    if (latestSnapshot !== null && ack.generation !== latestSnapshot.policy.generation) return;

    const isTerminal = ack.connectorState === 'effective' || ack.connectorState === 'rejected';
    // A values-only snapshot match already showed this command's request as
    // satisfied (`applySnapshot`'s tentative `'matches'`). A late-arriving
    // non-terminal ack (pending/offline) for the same command is stale
    // information relative to that authoritative snapshot and must not
    // downgrade the display back to "pending"/"offline" (P2).
    if (!isTerminal && view.policy.acknowledgment === 'matches') return;
    if (ack.connectorState === 'rejected') hasActionFailure = true;
    if (isTerminal) {
      pendingCommand = null;
      latestCommandId = null;
    }
    const reason = unavailableReason(latestSnapshot, config.viewerOwnerId, hasActionFailure);

    // `decodePolicyAck` guarantees `effectiveVersion === requestedVersion`
    // whenever `connectorState` is `effective` (packages/contracts), so an
    // effective ack for this exact command is normally authoritative for the
    // version/mode/paused it just set without waiting for a separate snapshot
    // to catch up (KTD2: an ack alone never carries mode, but this command's
    // own requested mode is known context, not inferred from the ack).
    // *Except* when a newer authoritative snapshot has already arrived while
    // this ack was in flight: writing the ack's older values then would roll
    // the display backward and poison the next request's `expectedPolicyVersion`
    // with a version the connector has already superseded. So the write is
    // skipped whenever it would move the effective version backward relative
    // to the latest snapshot already seen.
    const ackEffectiveVersionIsCurrent = latestSnapshot === null
      || latestSnapshot.policy.effectiveVersion === null
      || ack.effectiveVersion === null
      || ack.effectiveVersion >= latestSnapshot.policy.effectiveVersion;

    view = {
      ...view,
      controlsAvailable: reason === null,
      unavailableReason: reason,
      retryAvailable: false,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: command.expectedNextVersion,
        requestedPaused: command.requestedPaused,
        acknowledgment: ack.connectorState,
        errorCode: ack.errorCode,
        ...(ack.connectorState === 'effective' && ackEffectiveVersionIsCurrent
          ? { effectiveVersion: ack.effectiveVersion, effectiveMode: 'review' as const, paused: command.requestedPaused }
          : {}),
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

    hasActionFailure = true;
    lastFailedCommand = command;
    const reason = unavailableReason(latestSnapshot, config.viewerOwnerId, hasActionFailure);

    view = {
      ...view,
      controlsAvailable: reason === null,
      unavailableReason: reason,
      retryAvailable: true,
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

  /** Shared by a fresh request and a retry of a failed one — a retry reuses the same commandId/expectedPolicyVersion rather than starting a new command (AE2). */
  function submitCommand(command: PendingCommand): void {
    pendingCommand = command;
    latestCommandId = command.commandId;

    view = {
      ...view,
      notice: null,
      retryAvailable: false,
      policy: {
        ...view.policy,
        requestedMode: 'review',
        requestedVersion: command.expectedNextVersion,
        requestedPaused: command.requestedPaused,
        acknowledgment: 'pending',
        errorCode: null,
      },
    };
    notify();

    const wireCommand: PolicySetCommand = {
      v: 1,
      commandId: command.commandId,
      roomId: config.roomId,
      bindingId: config.bindingId,
      peerParticipantId: config.peerParticipantId,
      expectedPolicyVersion: command.expectedPolicyVersion,
      expectedBindingGeneration: command.expectedGeneration,
      mode: 'review',
      paused: command.requestedPaused,
      issuedAt: new Date().toISOString(),
    };

    port.submitPolicy(wireCommand)
      .then(ack => applyAck(command, ack))
      .catch(() => applySubmitFailure(command));
  }

  function requestPause(paused: boolean): void {
    if (disposed) return;
    if (!view.controlsAvailable) return;
    // Sourced from `latestSnapshot`, never the displayed `view`, so a request
    // always targets the version the connector actually last confirmed — the
    // view can otherwise show a request-derived (not snapshot-confirmed)
    // effective version transiently, and that must never be what the next
    // command's `expectedPolicyVersion` is built from.
    const expectedPolicyVersion = latestSnapshot?.policy.effectiveVersion ?? null;
    if (expectedPolicyVersion === null) return;

    lastFailedCommand = null;
    submitCommand({
      commandId: createId() as CommandId,
      expectedPolicyVersion,
      expectedNextVersion: expectedPolicyVersion + 1,
      expectedGeneration: latestSnapshot?.policy.generation ?? 0,
      requestedPaused: paused,
    });
  }

  function retry(): void {
    if (disposed) return;
    if (lastFailedCommand === null) return;
    // Retry bypasses only the action-failure disable it caused, never a
    // structural block (revoked, wrong owner, unsupported capability) that
    // may have appeared since — that still requires a refresh, not a retry.
    if (unavailableReason(latestSnapshot, config.viewerOwnerId, false) !== null) return;
    const command = lastFailedCommand;
    lastFailedCommand = null;
    submitCommand(command);
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
    retry,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      portDisposer?.();
    },
  };
}
