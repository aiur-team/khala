// Pure trust policy transitions. Nothing here persists or sends: callers store the
// returned state with their own compare-and-set and deliver the returned effects.

import {
  type BindingId, type OwnerId, type PolicyAck, type PolicySetCommand, type RoomId, samePolicySetCommandInput,
} from '@khala/contracts/delivery/index';
import type {
  AutomationConfig, JournalEntry, PolicyActor, PolicyChangeOutcome, PolicyChangeRejection, PolicyRevision,
  PublishPolicyEffect, TrustState, TrustView,
} from './types';

export type PolicyChange = Readonly<{
  state: TrustState;
  outcome: PolicyChangeOutcome;
  effects: readonly PublishPolicyEffect[];
}>;

export type AckIgnoredReason =
  | 'binding_mismatch'
  | 'stale_generation'
  | 'unknown_command'
  | 'version_mismatch'
  | 'superseded';

export type AckOutcome =
  | Readonly<{ applied: true; connectorState: PolicyAck['connectorState'] }>
  | Readonly<{ applied: false; reason: AckIgnoredReason }>;

export type AckTransition = Readonly<{ state: TrustState; outcome: AckOutcome }>;

const baseline = (version: number, generation: number): PolicyRevision => ({
  version, generation, commandId: null, mode: 'review', paused: false, peerParticipantId: null,
});

/**
 * State for a binding with no trust decision yet. The review baseline counts as
 * effective without an acknowledgment because it is the connector's fail-closed
 * default: without an acknowledged `auto` revision nothing is released.
 */
export function initialTrustState(input: Readonly<{
  roomId: RoomId;
  bindingId: BindingId;
  ownerId: OwnerId;
  generation: number;
  policyVersion: number;
}>): TrustState {
  const revision = baseline(input.policyVersion, input.generation);
  return {
    roomId: input.roomId,
    bindingId: input.bindingId,
    ownerId: input.ownerId,
    generation: input.generation,
    requested: revision,
    effective: revision,
    connector: null,
    journal: new Map(),
  };
}

export function isAutomationConfig(value: AutomationConfig | null): value is AutomationConfig {
  return value !== null && Number.isSafeInteger(value.maxCausalDepth) && value.maxCausalDepth > 0;
}

/**
 * Evaluates one human policy request against current state. Only an owner actor
 * whose authority matches the binding owner can change policy. The command must
 * name the current binding generation and policy version: a conflict is refused
 * so the owner refreshes and decides again, never last-write-wins. A retried
 * command id returns its first outcome; reusing it with other input is refused.
 *
 * `auto` is refused unless composition supplies an approved `automation` config
 * (G-AUTOMATION). Review and pause requests never need it.
 */
export function evaluatePolicyChange(
  state: TrustState,
  actor: PolicyActor,
  command: PolicySetCommand,
  automation: AutomationConfig | null,
): PolicyChange {
  // Refusals to non-owners are not journaled, so they cannot claim a command id.
  if (actor.kind !== 'owner' || actor.authority.ownerId !== state.ownerId) {
    return { state, outcome: { ok: false, code: 'forbidden' }, effects: [] };
  }

  const prior = state.journal.get(command.commandId);
  if (prior) {
    if (!samePolicySetCommandInput(prior.command, command)) {
      return { state, outcome: { ok: false, code: 'idempotency_conflict' }, effects: [] };
    }
    return { state, outcome: prior.outcome, effects: publishIfPending(state, prior) };
  }

  const code = refusal(state, command, automation);
  if (code) return settle(state, command, { ok: false, code });

  const requested: PolicyRevision = {
    version: state.requested.version + 1,
    generation: state.generation,
    commandId: command.commandId,
    mode: command.mode,
    paused: command.paused,
    peerParticipantId: command.peerParticipantId,
  };
  const next = settle({ ...state, requested, connector: null }, command, { ok: true, requested });
  return { ...next, effects: [{ kind: 'publish_policy', bindingId: state.bindingId, revision: requested }] };
}

function refusal(
  state: TrustState,
  command: PolicySetCommand,
  automation: AutomationConfig | null,
): PolicyChangeRejection | null {
  if (command.bindingId !== state.bindingId || command.roomId !== state.roomId) return 'binding_mismatch';
  if (command.expectedBindingGeneration !== state.generation) return 'stale_binding';
  if (command.expectedPolicyVersion !== state.requested.version) return 'stale_policy';
  if (command.mode === 'auto' && !isAutomationConfig(automation)) return 'automation_gated';
  return null;
}

function settle(state: TrustState, command: PolicySetCommand, outcome: PolicyChangeOutcome): PolicyChange {
  const journal = new Map(state.journal);
  journal.set(command.commandId, { command, outcome });
  return { state: { ...state, journal }, outcome, effects: [] };
}

/** A retry re-sends the request while it is still the newest and not yet enforced. */
function publishIfPending(state: TrustState, entry: JournalEntry): readonly PublishPolicyEffect[] {
  if (!entry.outcome.ok) return [];
  const revision = entry.outcome.requested;
  if (revision.version !== state.requested.version || state.effective?.version === revision.version) return [];
  return [{ kind: 'publish_policy', bindingId: state.bindingId, revision }];
}

/**
 * Applies a connector acknowledgment supplied by trusted composition. The ack must
 * echo the binding, its current generation and a command this state accepted, and
 * an `effective` ack must carry the version assigned to that command. Effective
 * state only moves forward, so a late ack for an older request cannot roll back a
 * newer one. An older request that the connector really did enforce still becomes
 * effective: hiding that would overstate review.
 */
export function applyPolicyAck(state: TrustState, ack: PolicyAck): AckTransition {
  const ignore = (reason: AckIgnoredReason): AckTransition => ({ state, outcome: { applied: false, reason } });
  if (ack.bindingId !== state.bindingId) return ignore('binding_mismatch');
  if (ack.generation !== state.generation) return ignore('stale_generation');

  const entry = state.journal.get(ack.commandId);
  if (!entry?.outcome.ok) return ignore('unknown_command');
  const revision = entry.outcome.requested;
  if (revision.generation !== state.generation) return ignore('stale_generation');
  if (ack.requestedVersion !== null && ack.requestedVersion !== revision.version) return ignore('version_mismatch');

  if (ack.connectorState === 'effective') {
    if (ack.effectiveVersion !== revision.version) return ignore('version_mismatch');
    if (state.effective && state.effective.version >= revision.version) return ignore('superseded');
    const connector = state.connector && state.connector.commandId === ack.commandId ? null : state.connector;
    return { state: { ...state, effective: revision, connector }, outcome: { applied: true, connectorState: 'effective' } };
  }

  if (revision.version !== state.requested.version) return ignore('superseded');
  const connector = { commandId: ack.commandId, state: ack.connectorState, errorCode: ack.errorCode };
  return { state: { ...state, connector }, outcome: { applied: true, connectorState: ack.connectorState } };
}

/**
 * Moves trust state to a new binding generation. Trust is never inherited: the
 * new generation starts from a fresh review baseline with a bumped version, so any
 * request or acknowledgment made for the old generation is stale.
 */
export function applyRebind(
  state: TrustState,
  generation: number,
): Readonly<{ ok: true; state: TrustState }> | Readonly<{ ok: false; code: 'stale_binding' }> {
  if (!Number.isSafeInteger(generation) || generation <= state.generation) return { ok: false, code: 'stale_binding' };
  const revision = baseline(state.requested.version + 1, generation);
  return { ok: true, state: { ...state, generation, requested: revision, effective: revision, connector: null } };
}

/** The claims a status surface may make about this binding's trust policy. */
export function trustView(state: TrustState): TrustView {
  const { requested, effective, connector } = state;
  const summary = (revision: PolicyRevision) => ({
    version: revision.version, mode: revision.mode, paused: revision.paused,
  });
  const status = effective?.version === requested.version
    ? 'effective'
    : connector?.state === 'rejected' ? 'rejected' : 'requested';
  return {
    requested: summary(requested),
    effective: effective ? summary(effective) : null,
    status,
    connectorState: status === 'effective' ? null : connector?.state ?? null,
  };
}
