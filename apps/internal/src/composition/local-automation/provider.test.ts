import type { CausalRootId, CommandId } from '@khala/contracts/delivery/index';
import { LOCAL_AUTOMATION_LIMITS, type LocalAutomationLimits } from '@khala/policy/listening-mode/limits';
import type { AutomaticReleaseInput } from '@khala/policy/trust/automatic';
import { CLOSED_AUTOMATION } from '@khala/policy/trust/gate';
import { applyPolicyAck, evaluatePolicyChange } from '@khala/policy/trust/transitions';
import type { TrustState } from '@khala/policy/trust/types';
import { describe, expect, it } from 'vitest';
import {
  ack, binding, causalRoot, command, event, owner, releaseId, start,
} from '../../../../../packages/policy/test/trust/fakes';
import {
  LOCAL_AUTOMATION_MARKER, type LocalAutomationProvider, createLocalAutomationProvider, evaluateLocalAutomaticRelease,
  evaluateLocalPolicyChange,
} from './provider';

const provider = (): LocalAutomationProvider => createLocalAutomationProvider(LOCAL_AUTOMATION_LIMITS);
const id = (value: string) => value as CommandId;
const idle = { releasedInCausalRoot: 0, activeJobs: 0 };

/** Acknowledged unpaused `auto` at version 2, armed through the local authority. */
function effectiveAuto(): TrustState {
  return applyPolicyAck(evaluateLocalPolicyChange(provider(), start(), owner(), command(), 'active').state, ack()).state;
}

/** Applies and acknowledges one follow-up owner command at the next version. */
function next(state: TrustState, commandId: string, paused: boolean): TrustState {
  const version = state.requested.version;
  const change = evaluateLocalPolicyChange(
    provider(), state, owner(), command({ commandId: id(commandId), expectedPolicyVersion: version, paused }), 'active',
  );
  expect(change.outcome.ok).toBe(true);
  return applyPolicyAck(change.state, ack({
    commandId: id(commandId), requestedVersion: version + 1, effectiveVersion: version + 1,
  })).state;
}

function input(
  state: TrustState, overrides: Partial<Omit<AutomaticReleaseInput, 'budgetRemaining'>> = {},
): Omit<AutomaticReleaseInput, 'budgetRemaining'> {
  const version = state.effective?.version ?? 0;
  return {
    state,
    freshness: { kind: 'confirmed', policyVersion: version, generation: 1 },
    bindingStatus: 'active',
    binding: binding(),
    event: event(),
    arrivedUnderPolicyVersion: version,
    causal: { rootId: causalRoot, depth: 0 },
    priorReleaseId: null,
    releaseId: releaseId(),
    ...overrides,
  };
}

describe('local automation provider', () => {
  it('carries the stable marker and only the approved causal depth into policy', () => {
    const local = provider();
    expect(local.marker).toBe(LOCAL_AUTOMATION_MARKER);
    expect(local.authority.approvedAutomation()).toEqual({ maxCausalDepth: 3 });
    expect(local.limits).toEqual(LOCAL_AUTOMATION_LIMITS);
    expect(Object.isFrozen(local) && Object.isFrozen(local.authority) && Object.isFrozen(local.limits)).toBe(true);
  });

  it.each([
    ['maxCausalDepth', 0],
    ['maxJobsPerCausalRoot', 1.5],
    ['maxConcurrentJobs', Number.MAX_SAFE_INTEGER + 1],
    ['busy', 'drop'],
  ] as const)('refuses an invalid %s instead of defaulting', (key, value) => {
    expect(() => createLocalAutomationProvider({ ...LOCAL_AUTOMATION_LIMITS, [key]: value } as LocalAutomationLimits))
      .toThrow(RangeError);
  });

  it('the same auto state is gated under hosted authority and bounded under the local provider', () => {
    expect(evaluatePolicyChange(start(), owner(), command(), 'active', CLOSED_AUTOMATION).outcome)
      .toEqual({ ok: false, code: 'automation_gated' });
    expect(evaluateLocalPolicyChange(provider(), start(), owner(), command(), 'active').outcome.ok).toBe(true);

    const state = effectiveAuto();
    expect(evaluateLocalAutomaticRelease(
      { ...provider(), authority: CLOSED_AUTOMATION }, input(state), idle,
    )).toEqual({ kind: 'held', reason: 'automation_gated' });
    expect(evaluateLocalAutomaticRelease(provider(), input(state), idle)).toMatchObject({
      kind: 'release', spec: { binding: binding(), events: [event()] }, budgetRemaining: 2,
    });
  });

  it('holds at the causal depth bound', () => {
    const state = effectiveAuto();
    expect(evaluateLocalAutomaticRelease(provider(), input(state, { causal: { rootId: causalRoot, depth: 2 } }), idle).kind)
      .toBe('release');
    expect(evaluateLocalAutomaticRelease(provider(), input(state, { causal: { rootId: causalRoot, depth: 3 } }), idle))
      .toEqual({ kind: 'held', reason: 'loop_limit' });
  });

  it('holds once the causal root has used its job budget, and a new root starts fresh', () => {
    const state = effectiveAuto();
    expect(evaluateLocalAutomaticRelease(provider(), input(state), { releasedInCausalRoot: 2, activeJobs: 0 }))
      .toMatchObject({ kind: 'release', budgetRemaining: 0 });
    for (const releasedInCausalRoot of [3, 4]) {
      expect(evaluateLocalAutomaticRelease(provider(), input(state), { releasedInCausalRoot, activeJobs: 0 }))
        .toEqual({ kind: 'held', reason: 'budget_exhausted' });
    }
    const human = { rootId: 'causal_human_2' as CausalRootId, depth: 0 };
    expect(evaluateLocalAutomaticRelease(provider(), input(state, { causal: human }), idle).kind).toBe('release');
  });

  it('waits while the only worker is busy', () => {
    expect(evaluateLocalAutomaticRelease(provider(), input(effectiveAuto()), { releasedInCausalRoot: 0, activeJobs: 1 }))
      .toEqual({ kind: 'wait' });
  });

  it('pause and stop win over waiting, loop and budget', () => {
    const busyAndSpent = { releasedInCausalRoot: 3, activeJobs: 1 };
    const deep = { rootId: causalRoot, depth: 3 };

    const paused = next(effectiveAuto(), 'cmd_pause', true);
    expect(evaluateLocalAutomaticRelease(provider(), input(paused, { causal: deep }), busyAndSpent))
      .toEqual({ kind: 'held', reason: 'paused' });

    const stopped = input(effectiveAuto(), { bindingStatus: 'revoked', causal: deep });
    expect(evaluateLocalAutomaticRelease(provider(), stopped, busyAndSpent))
      .toEqual({ kind: 'held', reason: 'binding_revoked' });
  });

  it('resume does not reset the causal-root budget', () => {
    const resumed = next(next(effectiveAuto(), 'cmd_pause', true), 'cmd_resume', false);
    expect(resumed.effective).toMatchObject({ mode: 'auto', paused: false, version: 4 });

    expect(evaluateLocalAutomaticRelease(provider(), input(resumed), { releasedInCausalRoot: 3, activeJobs: 0 }))
      .toEqual({ kind: 'held', reason: 'budget_exhausted' });
    expect(evaluateLocalAutomaticRelease(provider(), input(resumed), { releasedInCausalRoot: 1, activeJobs: 0 }))
      .toMatchObject({ kind: 'release', budgetRemaining: 1 });
  });

  it('refuses a corrupt ledger instead of treating it as a fresh budget', () => {
    for (const ledger of [{ releasedInCausalRoot: -1, activeJobs: 0 }, { releasedInCausalRoot: 0, activeJobs: Number.NaN }]) {
      expect(() => evaluateLocalAutomaticRelease(provider(), input(effectiveAuto()), ledger)).toThrow(RangeError);
    }
  });
});
