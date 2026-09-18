import type { BindingId } from '@khala/contracts/delivery/index';

export type PolicyMode = 'review' | 'auto';

export type PolicyAcknowledgment = 'pending' | 'effective' | 'offline' | 'rejected';

/**
 * Requested and effective state are tracked independently: an ack echoing the
 * browser's own most recent command is not guaranteed when concurrent commands
 * exist, so `requestedMode`/`requestedVersion` are local intent, never derived
 * from `effectiveMode`/`effectiveVersion`. `effectiveVersion === null` means no
 * authoritative snapshot has been observed yet, never that policy is version 0.
 */
export type PolicyDisplay = Readonly<{
  effectiveMode: PolicyMode | null;
  effectiveVersion: number | null;
  paused: boolean | null;
  requestedMode: PolicyMode | null;
  requestedVersion: number | null;
  acknowledgment: PolicyAcknowledgment;
}>;

export type ConnectionState = 'connected' | 'offline' | 'unknown';

/**
 * Local display projection over KHA-106 `PolicySetCommand`/`PolicyAck`/
 * `DeliveryReceipt`, not a replacement for those canonical contracts.
 * `controlsAvailable` is `true` only when the approved policy and the adapter's
 * inspected `HarnessCapabilities` both permit at least one control (KTD3) — it
 * is never simulated for a capability that was not observed.
 */
export type AgentControlsView = Readonly<{
  bindingId: BindingId;
  ownerLabel: string;
  agentLabel: string;
  roomLabel: string;
  policy: PolicyDisplay;
  connection: ConnectionState;
  controlsAvailable: boolean;
  unavailableReason: string | null;
  receiptDetail: string | null;
}>;

export const INITIAL_POLICY_DISPLAY: PolicyDisplay = {
  effectiveMode: null,
  effectiveVersion: null,
  paused: null,
  requestedMode: null,
  requestedVersion: null,
  acknowledgment: 'pending',
};

export function initialAgentControlsView(input: Readonly<{
  bindingId: BindingId;
  ownerLabel: string;
  agentLabel: string;
  roomLabel: string;
}>): AgentControlsView {
  return {
    bindingId: input.bindingId,
    ownerLabel: input.ownerLabel,
    agentLabel: input.agentLabel,
    roomLabel: input.roomLabel,
    policy: INITIAL_POLICY_DISPLAY,
    connection: 'unknown',
    controlsAvailable: false,
    unavailableReason: 'Waiting for an authoritative snapshot.',
    receiptDetail: null,
  };
}
