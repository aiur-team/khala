// The internal app's bounded automation authority. This is the only place outside
// policy tests that may open G-AUTOMATION, and `scripts/check-boundaries.mjs` keeps
// every hosted root from reaching it. It releases work only toward the user-started
// session named by the recipient binding; delivery itself stays with owner-supplied
// adapters.

import type { LocalAutomationLimits } from '@khala/policy/listening-mode/limits';
import {
  type AutomaticReleaseDecision, type AutomaticReleaseInput, evaluateAutomaticRelease,
} from '@khala/policy/trust/automatic';
import type { AutomationAuthority } from '@khala/policy/trust/gate';
import { type PolicyChange, evaluatePolicyChange } from '@khala/policy/trust/transitions';
import type { BindingStatus, PolicyActor, TrustState } from '@khala/policy/trust/types';
import type { PolicySetCommand } from '@khala/contracts/delivery/index';

/** Stable marker the boundary check looks for: no hosted graph may contain it. */
export const LOCAL_AUTOMATION_MARKER = 'khala:local-automation-authority';

export type LocalAutomationProvider = Readonly<{
  marker: typeof LOCAL_AUTOMATION_MARKER;
  authority: AutomationAuthority;
  limits: LocalAutomationLimits;
}>;

/** What the local release ledger has recorded, supplied by the caller that owns it. */
export type LocalReleaseLedger = Readonly<{
  /** Automatic releases already recorded for this event's causal root. */
  releasedInCausalRoot: number;
  /** Released jobs not yet finished across the channel. */
  activeJobs: number;
}>;

export type LocalAutomaticReleaseDecision = AutomaticReleaseDecision | Readonly<{ kind: 'wait' }>;

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

/**
 * Builds the bounded provider from limits the internal composition root passes in
 * explicitly. There is no default profile: omitting or corrupting a limit throws.
 */
export function createLocalAutomationProvider(limits: LocalAutomationLimits): LocalAutomationProvider {
  if (limits.busy !== 'wait') throw new RangeError('busy must be wait');
  const frozen: LocalAutomationLimits = Object.freeze({
    maxCausalDepth: positive(limits.maxCausalDepth, 'maxCausalDepth'),
    maxJobsPerCausalRoot: positive(limits.maxJobsPerCausalRoot, 'maxJobsPerCausalRoot'),
    maxConcurrentJobs: positive(limits.maxConcurrentJobs, 'maxConcurrentJobs'),
    busy: limits.busy,
  });
  const config = Object.freeze({ maxCausalDepth: frozen.maxCausalDepth });
  return Object.freeze({
    marker: LOCAL_AUTOMATION_MARKER,
    authority: Object.freeze({ approvedAutomation: () => config }),
    limits: frozen,
  });
}

/** An owner policy change evaluated under the local authority. */
export function evaluateLocalPolicyChange(
  provider: LocalAutomationProvider,
  state: TrustState,
  actor: PolicyActor,
  command: PolicySetCommand,
  bindingStatus: BindingStatus,
): PolicyChange {
  return evaluatePolicyChange(state, actor, command, bindingStatus, provider.authority);
}

/**
 * Decides one automatic release under the local profile. The shared policy runs
 * first, so stop (a revoked binding), pause, loop and budget holds always win over
 * waiting for a busy worker. The causal-root budget comes from the ledger, never
 * from policy version, so a pause and resume does not reset it; only a new
 * human-authored root starts a fresh budget.
 */
export function evaluateLocalAutomaticRelease(
  provider: LocalAutomationProvider,
  input: Omit<AutomaticReleaseInput, 'budgetRemaining'>,
  ledger: LocalReleaseLedger,
): LocalAutomaticReleaseDecision {
  const released = count(ledger.releasedInCausalRoot, 'releasedInCausalRoot');
  const active = count(ledger.activeJobs, 'activeJobs');
  const budgetRemaining = Math.max(0, provider.limits.maxJobsPerCausalRoot - released);
  const decision = evaluateAutomaticRelease({ ...input, budgetRemaining }, provider.authority);
  if (decision.kind === 'release' && active >= provider.limits.maxConcurrentJobs) return { kind: provider.limits.busy };
  return decision;
}
