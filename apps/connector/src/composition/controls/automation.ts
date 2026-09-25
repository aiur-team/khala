// Hosted trust policy is always evaluated under the closed automation authority:
// every `auto` request is refused and every event holds as `automation_gated`. The
// internal app's bounded provider is out of reach by the boundary check.

import type { PolicySetCommand } from '@khala/contracts/delivery/index';
import {
  type AutomaticReleaseDecision, type AutomaticReleaseInput, evaluateAutomaticRelease,
} from '@khala/policy/trust/automatic';
import { CLOSED_AUTOMATION } from '@khala/policy/trust/gate';
import { type PolicyChange, evaluatePolicyChange } from '@khala/policy/trust/transitions';
import type { BindingStatus, PolicyActor, TrustState } from '@khala/policy/trust/types';

export function evaluateHostedPolicyChange(
  state: TrustState,
  actor: PolicyActor,
  command: PolicySetCommand,
  bindingStatus: BindingStatus,
): PolicyChange {
  return evaluatePolicyChange(state, actor, command, bindingStatus, CLOSED_AUTOMATION);
}

export function evaluateHostedAutomaticRelease(input: AutomaticReleaseInput): AutomaticReleaseDecision {
  return evaluateAutomaticRelease(input, CLOSED_AUTOMATION);
}
