// The real G-AUTOMATION seam, unmocked: the closed hosted authority enables no
// `auto` request and releases nothing automatically, and nothing but an injected
// authority can open it.

import { describe, expect, it } from 'vitest';
import { type AutomaticReleaseInput, evaluateAutomaticRelease } from './automatic';
import {
  binding, causalRoot, command, event, exampleAutomation, owner, releaseId, start,
} from '../../test/trust/fakes';
import { type AutomationAuthority, CLOSED_AUTOMATION, approvedAutomation, resolveAutomation } from './gate';
import { type PolicyChange, evaluatePolicyChange } from './transitions';
import type { PolicyRevision, TrustState } from './types';

const plausibleConfigs = [{ maxCausalDepth: 1 }, { maxCausalDepth: 3 }, { maxCausalDepth: Number.MAX_SAFE_INTEGER }];

// Callers cannot pass raw limits through the typed API; this checks that smuggling
// one in where the authority belongs, or leaving it out, changes nothing.
const evaluateUntyped = evaluatePolicyChange as (...args: unknown[]) => PolicyChange;
const releaseUntyped = evaluateAutomaticRelease as (...args: unknown[]) => ReturnType<typeof evaluateAutomaticRelease>;
const forgedAuthorities: unknown[] = [undefined, null, ...plausibleConfigs, { approvedAutomation: plausibleConfigs[0] }];

/** A hand-built state that already claims an acknowledged, unpaused `auto` revision. */
function forgedAutoState(): TrustState {
  const base = start();
  const auto: PolicyRevision = {
    ...base.requested, version: 2, commandId: command().commandId, mode: 'auto', peerParticipantId: event().authorParticipantId,
  };
  return { ...base, requested: auto, effective: auto };
}

function forgedInput(): AutomaticReleaseInput {
  return {
    state: forgedAutoState(),
    freshness: { kind: 'confirmed', policyVersion: 2, generation: 1 },
    binding: binding(),
    bindingStatus: 'active',
    event: event(),
    arrivedUnderPolicyVersion: 2,
    causal: { rootId: causalRoot, depth: 0 },
    budgetRemaining: 5,
    priorReleaseId: null,
    releaseId: releaseId(),
  };
}

describe('G-AUTOMATION gate', () => {
  it('the hosted seam has no approved automation limits', () => {
    expect(approvedAutomation()).toBeNull();
    expect(CLOSED_AUTOMATION.approvedAutomation()).toBeNull();
    expect(resolveAutomation(CLOSED_AUTOMATION)).toBeNull();
    expect(Object.isFrozen(CLOSED_AUTOMATION)).toBe(true);
  });

  it('refuses every owner auto request under the closed authority or a forged one', () => {
    expect(evaluatePolicyChange(start(), owner(), command(), 'active', CLOSED_AUTOMATION).outcome)
      .toEqual({ ok: false, code: 'automation_gated' });
    for (const forged of forgedAuthorities) {
      const change = evaluateUntyped(start(), owner(), command(), 'active', forged);
      expect(change.outcome).toEqual({ ok: false, code: 'automation_gated' });
      expect(change.effects).toEqual([]);
    }
  });

  it('still accepts review, pause and resume requests under the closed authority', () => {
    for (const paused of [true, false]) {
      expect(evaluatePolicyChange(start(), owner(), command({ mode: 'review', paused }), 'active', CLOSED_AUTOMATION).outcome.ok)
        .toBe(true);
    }
  });

  it('releases nothing automatically, even from a state claiming effective auto', () => {
    const input = forgedInput();
    expect(evaluateAutomaticRelease(input, CLOSED_AUTOMATION)).toEqual({ kind: 'held', reason: 'automation_gated' });
    for (const forged of forgedAuthorities) {
      expect(releaseUntyped(input, forged)).toEqual({ kind: 'held', reason: 'automation_gated' });
    }
    for (const automation of plausibleConfigs) {
      expect(releaseUntyped({ ...input, automation }, CLOSED_AUTOMATION)).toEqual({ kind: 'held', reason: 'automation_gated' });
    }
  });

  it('opens only for an explicitly injected authority with valid limits', () => {
    const bounded: AutomationAuthority = exampleAutomation(3);
    expect(evaluatePolicyChange(start(), owner(), command(), 'active', bounded).outcome.ok).toBe(true);
    expect(evaluateAutomaticRelease(forgedInput(), bounded).kind).toBe('release');
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(evaluateAutomaticRelease(forgedInput(), exampleAutomation(invalid)))
        .toEqual({ kind: 'held', reason: 'automation_gated' });
    }
  });
});
