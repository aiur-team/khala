// Browser side of the connector's owner-scoped controls status (KHA-135). The body is
// decoded strictly at the boundary: anything malformed is unavailable, never partial.
// Effective values are the policy the connector's dispatcher enforces; an accepted
// request it has not enforced yet stays in `requested` and never reads as effective.

import {
  type BindingId, type CommandId, type DeliveryReceipt, type HarnessCapabilities, type PolicyAck,
  type SessionBinding, decodeCommandId, decodeDeliveryReceipt, decodeHarnessCapabilities, decodeSessionBinding,
} from '@khala/contracts/delivery/index';
import type { AgentControlsSnapshot, PolicySnapshot } from '../../features/agent-controls/ports';

type Mode = 'review' | 'auto';

export type ControlsRequested = Readonly<{
  commandId: CommandId;
  version: number;
  mode: Mode;
  paused: boolean;
  connectorState: Exclude<PolicyAck['connectorState'], 'effective'>;
  errorCode: PolicyAck['errorCode'];
}>;

export type ControlsStatus = Readonly<{
  binding: SessionBinding;
  bindingStatus: 'active' | 'revoked';
  capabilities: HarnessCapabilities | null;
  policy: PolicySnapshot;
  requested: ControlsRequested | null;
  busy: boolean;
  latestReceipt: DeliveryReceipt | null;
}>;

const STATUS_KEYS = 'binding,bindingStatus,busy,capabilities,latestReceipt,policy,requested,v';
const POLICY_KEYS = 'bindingId,effectiveMode,effectiveVersion,generation,paused';
const REQUESTED_KEYS = 'commandId,connectorState,errorCode,mode,paused,version';
const MODES: readonly unknown[] = ['review', 'auto'];
const PENDING_STATES: readonly unknown[] = ['pending', 'offline', 'rejected'];
const ACK_ERRORS: readonly unknown[] = [
  'forbidden', 'stale_policy', 'stale_binding', 'idempotency_conflict', 'unavailable', 'outcome_unknown',
];

function record(value: unknown, keys: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys;
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function decodePolicy(input: unknown, binding: SessionBinding): PolicySnapshot | null {
  if (!record(input, POLICY_KEYS)) return null;
  if (input.bindingId !== binding.bindingId || input.generation !== binding.generation) return null;
  const { effectiveVersion, effectiveMode, paused } = input;
  // Null means no authoritative revision was observed; it is never coerced to zero.
  if (effectiveVersion !== null && !count(effectiveVersion)) return null;
  if (effectiveMode !== null && !MODES.includes(effectiveMode)) return null;
  if (paused !== null && typeof paused !== 'boolean') return null;
  if (effectiveVersion === null && (effectiveMode !== null || paused !== null)) return null;
  return {
    bindingId: binding.bindingId,
    generation: binding.generation,
    effectiveVersion,
    effectiveMode: effectiveMode as Mode | null,
    paused,
  };
}

function decodeRequested(input: unknown, policy: PolicySnapshot): ControlsRequested | null | 'invalid' {
  if (input === null) return null;
  if (!record(input, REQUESTED_KEYS)) return 'invalid';
  const commandId = decodeCommandId(input.commandId);
  if (!commandId.ok || !count(input.version) || !MODES.includes(input.mode) || typeof input.paused !== 'boolean') {
    return 'invalid';
  }
  if (!PENDING_STATES.includes(input.connectorState)) return 'invalid';
  if (input.errorCode !== null && !ACK_ERRORS.includes(input.errorCode)) return 'invalid';
  // A request the connector already enforces is not pending.
  if (policy.effectiveVersion !== null && input.version <= policy.effectiveVersion) return 'invalid';
  return {
    commandId: commandId.value,
    version: input.version,
    mode: input.mode as Mode,
    paused: input.paused,
    connectorState: input.connectorState as ControlsRequested['connectorState'],
    errorCode: input.errorCode as PolicyAck['errorCode'],
  };
}

export function decodeControlsStatus(input: unknown, bindingId: BindingId): ControlsStatus | null {
  if (!record(input, STATUS_KEYS) || input.v !== 1) return null;
  const binding = decodeSessionBinding(input.binding);
  if (!binding.ok || binding.value.bindingId !== bindingId) return null;
  if (input.bindingStatus !== 'active' && input.bindingStatus !== 'revoked') return null;
  if (typeof input.busy !== 'boolean') return null;
  let capabilities: HarnessCapabilities | null = null;
  if (input.capabilities !== null) {
    const decoded = decodeHarnessCapabilities(input.capabilities);
    if (!decoded.ok) return null;
    capabilities = decoded.value;
  }
  let latestReceipt: DeliveryReceipt | null = null;
  if (input.latestReceipt !== null) {
    const decoded = decodeDeliveryReceipt(input.latestReceipt);
    if (!decoded.ok || decoded.value.bindingId !== bindingId) return null;
    latestReceipt = decoded.value;
  }
  const policy = decodePolicy(input.policy, binding.value);
  if (policy === null) return null;
  const requested = decodeRequested(input.requested, policy);
  if (requested === 'invalid') return null;
  return {
    binding: binding.value,
    bindingStatus: input.bindingStatus,
    capabilities,
    policy,
    requested,
    busy: input.busy,
    latestReceipt,
  };
}

export function toAgentControlsSnapshot(
  status: ControlsStatus,
  connection: AgentControlsSnapshot['connection'],
): AgentControlsSnapshot {
  return {
    binding: status.binding,
    bindingStatus: status.bindingStatus,
    capabilities: status.capabilities,
    policy: status.policy,
    connection,
    latestReceipt: status.latestReceipt,
    // No owner listening-mode route is served to the hosted browser yet.
    listening: null,
  };
}

/** Safe, serialisable controls state for status, logs and telemetry. */
export type ControlsObservation = Readonly<{
  generation: number;
  bindingStatus: ControlsStatus['bindingStatus'];
  connection: AgentControlsSnapshot['connection'];
  effectiveVersion: number | null;
  effectiveMode: Mode | null;
  paused: boolean | null;
  requestedCommandId: string | null;
  requestedVersion: number | null;
  requestedState: ControlsRequested['connectorState'] | null;
  requestedError: PolicyAck['errorCode'];
  busy: boolean;
  receipt: DeliveryReceipt['kind'] | null;
}>;

/**
 * Built field by field from an allow-list, so no session ID, owner, key or message
 * content can reach it whatever the status carries.
 */
export function projectControls(
  status: ControlsStatus,
  connection: AgentControlsSnapshot['connection'],
): ControlsObservation {
  return {
    generation: status.policy.generation,
    bindingStatus: status.bindingStatus,
    connection,
    effectiveVersion: status.policy.effectiveVersion,
    effectiveMode: status.policy.effectiveMode,
    paused: status.policy.paused,
    requestedCommandId: status.requested?.commandId ?? null,
    requestedVersion: status.requested?.version ?? null,
    requestedState: status.requested?.connectorState ?? null,
    requestedError: status.requested?.errorCode ?? null,
    busy: status.busy,
    receipt: status.latestReceipt?.kind ?? null,
  };
}
