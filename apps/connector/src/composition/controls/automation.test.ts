// Wrong-implementation test for the automation fence: hosted `auto` must hold even
// for a state that a bounded authority armed and a connector acknowledged. A global
// default in `gate.ts` or a hosted import of a bounded provider opens this gate.

import type { AutomaticReleaseInput } from '@khala/policy/trust/automatic';
import { applyPolicyAck, evaluatePolicyChange } from '@khala/policy/trust/transitions';
import type { TrustState } from '@khala/policy/trust/types';
import { describe, expect, it } from 'vitest';
import {
  ack, binding, causalRoot, command, event, exampleAutomation, owner, releaseId, start,
} from '../../../../../packages/policy/test/trust/fakes';
import { evaluateHostedAutomaticRelease, evaluateHostedPolicyChange } from './automation';

/** Effective unpaused `auto`, as a bounded (non-hosted) authority would have armed it. */
function armedElsewhere(): TrustState {
  return applyPolicyAck(evaluatePolicyChange(start(), owner(), command(), 'active', exampleAutomation()).state, ack()).state;
}

function input(overrides: Partial<AutomaticReleaseInput> = {}): AutomaticReleaseInput {
  return {
    state: armedElsewhere(),
    freshness: { kind: 'confirmed', policyVersion: 2, generation: 1 },
    bindingStatus: 'active',
    binding: binding(),
    event: event(),
    arrivedUnderPolicyVersion: 2,
    causal: { rootId: causalRoot, depth: 0 },
    budgetRemaining: 5,
    priorReleaseId: null,
    releaseId: releaseId(),
    ...overrides,
  };
}

describe('hosted automation authority', () => {
  it('refuses every owner auto request', () => {
    const change = evaluateHostedPolicyChange(start(), owner(), command(), 'active');
    expect(change.outcome).toEqual({ ok: false, code: 'automation_gated' });
    expect(change.effects).toEqual([]);
  });

  it('still accepts review, pause and resume', () => {
    for (const paused of [true, false]) {
      expect(evaluateHostedPolicyChange(start(), owner(), command({ mode: 'review', paused }), 'active').outcome.ok).toBe(true);
    }
  });

  it('holds an event that a bounded authority would release', () => {
    expect(evaluatePolicyChange(start(), owner(), command(), 'active', exampleAutomation()).outcome.ok).toBe(true);
    expect(evaluateHostedAutomaticRelease(input())).toEqual({ kind: 'held', reason: 'automation_gated' });
  });
});
