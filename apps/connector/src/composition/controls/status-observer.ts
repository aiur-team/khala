// Owner-facing controls status for one binding, read in one dispatch ledger transaction.
// Effective values come from the policy the dispatcher enforces, never from the last
// request or acknowledgment. A request the ledger has not enforced yet stays `requested`.

import type {
  BindingId, CommandId, DeliveryReceipt, HarnessCapabilities, PolicyAck, SessionBinding,
} from '@khala/contracts/delivery/index';
import type { DispatchTx } from '@khala/connector/dispatch/types';
import type { PolicyMode, TrustState } from '@khala/policy/trust/index';

export type ControlsPolicyStatus = Readonly<{
  bindingId: BindingId;
  generation: number;
  /** The enforced policy version; null when the connector has no applied policy. */
  effectiveVersion: number | null;
  /** Null when the enforced version is not one this connector's trust state recorded. */
  effectiveMode: PolicyMode | null;
  paused: boolean | null;
}>;

/** An accepted owner request the dispatcher does not enforce yet. */
export type ControlsRequestedStatus = Readonly<{
  commandId: CommandId;
  version: number;
  mode: PolicyMode;
  paused: boolean;
  connectorState: Exclude<PolicyAck['connectorState'], 'effective'>;
  errorCode: PolicyAck['errorCode'];
}>;

/** Wire body of the protected controls status read. Carries no content, key or authority. */
export type ControlsStatus = Readonly<{
  v: 1;
  binding: SessionBinding;
  bindingStatus: 'active' | 'revoked';
  capabilities: HarnessCapabilities | null;
  policy: ControlsPolicyStatus;
  requested: ControlsRequestedStatus | null;
  /** Whether the bound session holds claimed or dispatching work right now. */
  busy: boolean;
  /** Newest receipt of the binding's active work, or null. Never a consumption claim. */
  latestReceipt: DeliveryReceipt | null;
}>;

/** Reads the ledger half of the status. The caller has already checked the owner. */
export function observeStatus(
  tx: DispatchTx,
  binding: SessionBinding,
  revoked: boolean,
): Omit<ControlsStatus, 'capabilities' | 'requested' | 'policy'> & Readonly<{
  enforced: Readonly<{ version: number; paused: boolean }> | null;
}> {
  const policy = tx.policy(binding.bindingId);
  const active = tx.active().filter(record => record.job.binding.bindingId === binding.bindingId);
  let latestReceipt: DeliveryReceipt | null = null;
  for (const record of active) {
    for (const receipt of record.receipts) if (receipt.v === 1) latestReceipt = receipt;
  }
  return {
    v: 1,
    binding,
    bindingStatus: revoked ? 'revoked' : 'active',
    busy: active.length > 0,
    latestReceipt,
    enforced: policy === null ? null : { version: policy.version, paused: policy.paused },
  };
}

/**
 * Joins what the ledger enforces with what trust state recorded. A missing trust state
 * means no owner request was ever made here: the connector's fail-closed baseline is
 * review, and hosted automation is closed, so nothing is released without review.
 */
export function policyStatus(
  binding: SessionBinding,
  enforced: Readonly<{ version: number; paused: boolean }> | null,
  trust: TrustState | null,
): Readonly<{ policy: ControlsPolicyStatus; requested: ControlsRequestedStatus | null }> {
  const current = trust !== null && trust.generation === binding.generation ? trust : null;
  const effectiveMode = enforced === null
    ? null
    : current === null
      ? 'review'
      : current.effective?.version === enforced.version ? current.effective.mode : null;
  const pending = current?.requested;
  const requested = pending && pending.commandId !== null && enforced !== null && pending.version > enforced.version
    ? {
      commandId: pending.commandId,
      version: pending.version,
      mode: pending.mode,
      paused: pending.paused,
      connectorState: current?.connector?.commandId === pending.commandId ? current.connector.state : 'pending',
      errorCode: current?.connector?.commandId === pending.commandId ? current.connector.errorCode : null,
    } satisfies ControlsRequestedStatus
    : null;
  return {
    policy: {
      bindingId: binding.bindingId,
      generation: binding.generation,
      effectiveVersion: enforced?.version ?? null,
      effectiveMode,
      paused: enforced?.paused ?? null,
    },
    requested,
  };
}
