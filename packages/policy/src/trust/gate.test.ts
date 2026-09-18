// The real G-AUTOMATION seam, unmocked: while the gate is open no input enables
// `auto` or releases anything automatically.

import { describe, expect, it } from 'vitest';
import { type AutomaticReleaseInput, evaluateAutomaticRelease } from './automatic';
import {
  binding, causalRoot, command, event, owner, releaseId, start,
} from '../../test/trust/fakes';
import { approvedAutomation } from './gate';
import { type PolicyChange, evaluatePolicyChange } from './transitions';
import type { PolicyRevision, TrustState } from './types';

const plausibleConfigs = [{ maxCausalDepth: 1 }, { maxCausalDepth: 3 }, { maxCausalDepth: Number.MAX_SAFE_INTEGER }];

// Callers cannot pass limits through the typed API; this checks that smuggling one
// in anyway changes nothing.
const evaluateWithExtra = evaluatePolicyChange as (...args: unknown[]) => PolicyChange;

/** A hand-built state that already claims an acknowledged, unpaused `auto` revision. */
function forgedAutoState(): TrustState {
  const base = start();
  const auto: PolicyRevision = {
    ...base.requested, version: 2, commandId: command().commandId, mode: 'auto', peerParticipantId: event().authorParticipantId,
  };
  return { ...base, requested: auto, effective: auto };
}

describe('G-AUTOMATION gate', () => {
  it('has no approved automation limits', () => {
    expect(approvedAutomation()).toBeNull();
  });

  it('refuses every owner auto request, whatever config the caller passes', () => {
    expect(evaluatePolicyChange(start(), owner(), command(), 'active').outcome)
      .toEqual({ ok: false, code: 'automation_gated' });
    for (const config of plausibleConfigs) {
      const change = evaluateWithExtra(start(), owner(), command(), 'active', config);
      expect(change.outcome).toEqual({ ok: false, code: 'automation_gated' });
      expect(change.effects).toEqual([]);
    }
  });

  it('still accepts review, pause and resume requests', () => {
    for (const paused of [true, false]) {
      expect(evaluatePolicyChange(start(), owner(), command({ mode: 'review', paused }), 'active').outcome.ok).toBe(true);
    }
  });

  it('releases nothing automatically, even from a state claiming effective auto', () => {
    const state = forgedAutoState();
    const input: AutomaticReleaseInput = {
      state,
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

    expect(evaluateAutomaticRelease(input)).toEqual({ kind: 'held', reason: 'automation_gated' });
    for (const automation of plausibleConfigs) {
      expect(evaluateAutomaticRelease({ ...input, automation } as AutomaticReleaseInput))
        .toEqual({ kind: 'held', reason: 'automation_gated' });
    }
  });
});
