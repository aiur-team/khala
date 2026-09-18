import type { BindingId, OwnerId, PolicyAckErrorCode } from '@khala/contracts/delivery/index';

export type PolicyMode = 'review' | 'auto';

/**
 * `'effective'` is reserved for this exact command's own terminal ack from
 * the connector — never for a values-only snapshot coincidence, which is
 * `'matches'` instead (a request that could have been satisfied by anyone,
 * not proof this command produced it).
 */
export type PolicyAcknowledgment = 'pending' | 'effective' | 'matches' | 'offline' | 'rejected' | 'unknown';

/**
 * Requested and effective state are tracked independently: an ack echoing the
 * browser's own most recent command is not guaranteed when concurrent commands
 * exist, so `requestedMode`/`requestedVersion`/`requestedPaused` are local
 * intent, never derived from `effectiveMode`/`effectiveVersion`/`paused`.
 * `effectiveVersion === null` means no authoritative snapshot has been
 * observed yet, never that policy is version 0. A failed or stale request
 * keeps its requested fields (never coerced to `null`) so the human can see
 * what was asked for and retry with the same identity (AE2); `errorCode`
 * carries the closed failure vocabulary rather than being dropped.
 */
export type PolicyDisplay = Readonly<{
  effectiveMode: PolicyMode | null;
  effectiveVersion: number | null;
  paused: boolean | null;
  requestedMode: PolicyMode | null;
  requestedVersion: number | null;
  requestedPaused: boolean | null;
  acknowledgment: PolicyAcknowledgment;
  errorCode: PolicyAckErrorCode | null;
}>;

export type ConnectionState = 'connected' | 'offline' | 'unknown';

/** A transient, dismiss-by-refresh notice about something the human should act on. */
export type AgentControlsNotice = Readonly<{
  kind: 'binding-replaced' | 'request-failed' | 'snapshot-error';
  message: string;
}>;

/**
 * Local display projection over KHA-106 `PolicySetCommand`/`PolicyAck`/
 * `DeliveryReceipt`, not a replacement for those canonical contracts.
 * `controlsAvailable` is `true` only when the binding is active, viewer-owned,
 * and the approved policy and the adapter's inspected `HarnessCapabilities`
 * both permit at least one control (KTD3) — it is never simulated for a
 * capability that was not observed.
 */
export type AgentControlsView = Readonly<{
  bindingId: BindingId;
  ownerLabel: string;
  agentLabel: string;
  roomLabel: string;
  isViewerOwned: boolean;
  revoked: boolean;
  policy: PolicyDisplay;
  connection: ConnectionState;
  controlsAvailable: boolean;
  unavailableReason: string | null;
  /** The exact inspected harness support/existing-session states, shown honestly regardless of whether they gate the controls. */
  capabilityDetail: string | null;
  /** True only after a genuinely unknown-outcome (network) failure; drives a distinct "Retry" affordance from the general "Refresh" recovery action. */
  retryAvailable: boolean;
  notice: AgentControlsNotice | null;
  receiptDetail: string | null;
}>;

export const INITIAL_POLICY_DISPLAY: PolicyDisplay = {
  effectiveMode: null,
  effectiveVersion: null,
  paused: null,
  requestedMode: null,
  requestedVersion: null,
  requestedPaused: null,
  acknowledgment: 'pending',
  errorCode: null,
};

/**
 * "Your agent" / "Another person's agent" is derived from `ownerId` compared
 * against the viewer's own, never from a caller-supplied free string — a
 * sibling feature (`timeline/attribution.ts`) does the equivalent for the
 * message list, but cross-feature imports are disallowed here (see
 * `scripts/check-boundaries.mjs`), so the comparison is reimplemented locally.
 * The owner suffix disambiguates two different owners who might otherwise
 * render identically in this single-binding panel; a longer slice than a bare
 * `#last4` is used since owner ids are opaque strings, not guaranteed to vary
 * only in their last few characters.
 */
export function ownerLabelFor(bindingOwnerId: OwnerId, viewerOwnerId: OwnerId): string {
  if (bindingOwnerId === viewerOwnerId) return 'Your agent';
  return `Another person's agent (#${bindingOwnerId.slice(-8)})`;
}

export function initialAgentControlsView(input: Readonly<{
  bindingId: BindingId;
  agentLabel: string;
  roomLabel: string;
}>): AgentControlsView {
  return {
    bindingId: input.bindingId,
    ownerLabel: 'Unknown owner',
    agentLabel: input.agentLabel,
    roomLabel: input.roomLabel,
    isViewerOwned: false,
    revoked: false,
    policy: INITIAL_POLICY_DISPLAY,
    connection: 'unknown',
    controlsAvailable: false,
    unavailableReason: 'Waiting for an authoritative snapshot.',
    capabilityDetail: null,
    retryAvailable: false,
    notice: null,
    receiptDetail: null,
  };
}
