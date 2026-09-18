// Narrow automatic release: one newly arrived peer event, under one acknowledged
// auto revision, for the binding generation that revision was acknowledged for.
// There is no all-pending path; a backlog is released only by an explicit owner
// selection through the exact approval flow.

import type {
  CausalRootId, EventRef, ReleaseApproval, ReleaseId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { isAutomationConfig } from './transitions';
import type { AutomationConfig, TrustState } from './types';

/**
 * What the connector proved about policy freshness since it last connected. It
 * may evaluate queued events only after fetching the latest authoritative policy.
 */
export type PolicyFreshness =
  | Readonly<{ kind: 'confirmed'; policyVersion: number; generation: number }>
  | Readonly<{ kind: 'unconfirmed' }>;

export type AutomaticReleaseInput = Readonly<{
  /** Null when policy state is missing, for example after a restart before reconciliation. */
  state: TrustState | null;
  freshness: PolicyFreshness;
  /** G-AUTOMATION limits; null until approved. */
  automation: AutomationConfig | null;
  /** The recipient binding as it is now. */
  binding: SessionBinding;
  event: EventRef;
  /** The effective policy version in force when the connector received `event`. */
  arrivedUnderPolicyVersion: number;
  causal: Readonly<{ rootId: CausalRootId; depth: number }>;
  /** Automatic releases still allowed by the caller's budget ledger. */
  budgetRemaining: number;
  /** The release already recorded for this event and generation, if any. */
  priorReleaseId: ReleaseId | null;
  /** Identity for a new release; used only when this call releases. */
  releaseId: ReleaseId;
}>;

/** Content-free reasons an event stays held for owner review. */
export type HoldReason =
  | 'automation_gated'
  | 'policy_unknown'
  | 'policy_unconfirmed'
  | 'policy_pending'
  | 'not_auto'
  | 'paused'
  | 'stale_binding'
  | 'room_mismatch'
  | 'peer_not_allowed'
  | 'backlog'
  | 'loop_limit'
  | 'budget_exhausted';

/**
 * The exact immutable release the payload encoder turns into a `ReleasedJob`. It
 * carries the same approval, binding, policy and event fields; `approval` names
 * the acknowledged policy command that authorised it, not a per-event approval.
 */
export type AutomaticReleaseSpec = Readonly<{
  releaseId: ReleaseId;
  approval: ReleaseApproval;
  binding: SessionBinding;
  policyVersion: number;
  events: readonly [EventRef];
  causalRootId: CausalRootId;
}>;

export type AutomaticReleaseDecision =
  | Readonly<{ kind: 'release'; spec: AutomaticReleaseSpec; budgetRemaining: number }>
  | Readonly<{ kind: 'duplicate'; releaseId: ReleaseId }>
  | Readonly<{ kind: 'held'; reason: HoldReason }>;

const held = (reason: HoldReason): AutomaticReleaseDecision => ({ kind: 'held', reason });

/**
 * Decides whether one event may be released without owner review. Every doubt
 * holds: missing or unconfirmed policy, a newer request not yet enforced, a
 * changed binding, a peer outside scope, an event that predates activation, or an
 * exhausted budget or causal chain. An event that was already released keeps its
 * release identity; delivered content cannot be recalled, so a retry must not
 * mint another release.
 */
export function evaluateAutomaticRelease(input: AutomaticReleaseInput): AutomaticReleaseDecision {
  const { state, freshness, binding, event } = input;
  if (input.priorReleaseId !== null) return { kind: 'duplicate', releaseId: input.priorReleaseId };
  if (!isAutomationConfig(input.automation)) return held('automation_gated');
  if (state === null || state.effective === null) return held('policy_unknown');
  if (freshness.kind !== 'confirmed') return held('policy_unconfirmed');

  const { requested, effective } = state;
  if (freshness.generation !== state.generation || freshness.policyVersion !== requested.version) {
    return held('policy_unconfirmed');
  }
  if (effective.version !== requested.version) return held('policy_pending');
  if (effective.mode !== 'auto' || effective.commandId === null) return held('not_auto');
  if (effective.paused) return held('paused');
  if (binding.bindingId !== state.bindingId || binding.generation !== state.generation
    || effective.generation !== binding.generation) {
    return held('stale_binding');
  }
  if (event.roomId !== state.roomId) return held('room_mismatch');
  if (event.authorParticipantId !== effective.peerParticipantId
    || event.authorParticipantId === binding.agentParticipantId) {
    return held('peer_not_allowed');
  }
  if (input.arrivedUnderPolicyVersion !== effective.version) return held('backlog');
  if (!Number.isSafeInteger(input.causal.depth) || input.causal.depth < 0
    || input.causal.depth >= input.automation.maxCausalDepth) {
    return held('loop_limit');
  }
  if (!Number.isSafeInteger(input.budgetRemaining) || input.budgetRemaining < 1) return held('budget_exhausted');

  return {
    kind: 'release',
    spec: {
      releaseId: input.releaseId,
      approval: {
        commandId: effective.commandId,
        policyVersion: effective.version,
        bindingGeneration: effective.generation,
      },
      binding,
      policyVersion: effective.version,
      events: [event],
      causalRootId: input.causal.rootId,
    },
    budgetRemaining: input.budgetRemaining - 1,
  };
}
