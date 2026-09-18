import { describe, expect, it } from 'vitest';
import type { CommandId } from '@khala/contracts/delivery/index';
import { type AutomaticReleaseInput, evaluateAutomaticRelease } from './automatic';
import {
  AUTOMATION, BINDING, OTHER_PEER, OWN_AGENT, PEER, ack, binding, causalRoot, command, event, owner, releaseId, start,
} from './fakes';
import { applyPolicyAck, evaluatePolicyChange } from './transitions';
import type { TrustState } from './types';

const id = (value: string) => value as CommandId;

function effectiveAuto(overrides: Parameters<typeof command>[0] = {}): TrustState {
  const change = evaluatePolicyChange(start(), owner(), command(overrides), AUTOMATION);
  return applyPolicyAck(change.state, ack()).state;
}

function input(overrides: Partial<AutomaticReleaseInput> = {}): AutomaticReleaseInput {
  return {
    state: effectiveAuto(),
    freshness: { kind: 'confirmed', policyVersion: 2, generation: 1 },
    automation: AUTOMATION,
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

describe('automatic release', () => {
  it('releases one new event from the allowed peer under effective unpaused auto', () => {
    const decision = evaluateAutomaticRelease(input());

    expect(decision).toEqual({
      kind: 'release',
      spec: {
        releaseId: 'release_1',
        approval: { commandId: 'cmd_1', policyVersion: 2, bindingGeneration: 1 },
        binding: binding(),
        policyVersion: 2,
        events: [event()],
        causalRootId: causalRoot,
      },
      budgetRemaining: 4,
    });
  });

  it('holds in review mode, while paused, and while auto is only requested', () => {
    const review = applyPolicyAck(
      evaluatePolicyChange(start(), owner(), command({ mode: 'review' }), AUTOMATION).state,
      ack(),
    ).state;
    expect(evaluateAutomaticRelease(input({ state: review }))).toEqual({ kind: 'held', reason: 'not_auto' });
    expect(evaluateAutomaticRelease(input({ state: start(), freshness: { kind: 'confirmed', policyVersion: 1, generation: 1 } })))
      .toEqual({ kind: 'held', reason: 'not_auto' });

    const paused = effectiveAuto({ paused: true });
    expect(evaluateAutomaticRelease(input({ state: paused }))).toEqual({ kind: 'held', reason: 'paused' });

    const requestedOnly = evaluatePolicyChange(start(), owner(), command(), AUTOMATION).state;
    expect(evaluateAutomaticRelease(input({ state: requestedOnly }))).toEqual({ kind: 'held', reason: 'policy_pending' });
  });

  it('holds once a re-arm is requested, even before the connector acknowledges it', () => {
    const rearm = evaluatePolicyChange(
      effectiveAuto(), owner(), command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }), AUTOMATION,
    ).state;

    expect(evaluateAutomaticRelease(input({ state: rearm, freshness: { kind: 'confirmed', policyVersion: 3, generation: 1 } })))
      .toEqual({ kind: 'held', reason: 'policy_pending' });
  });

  it('holds with missing, unconfirmed or stale policy freshness', () => {
    expect(evaluateAutomaticRelease(input({ state: null }))).toEqual({ kind: 'held', reason: 'policy_unknown' });
    expect(evaluateAutomaticRelease(input({ freshness: { kind: 'unconfirmed' } })))
      .toEqual({ kind: 'held', reason: 'policy_unconfirmed' });
    expect(evaluateAutomaticRelease(input({ freshness: { kind: 'confirmed', policyVersion: 3, generation: 1 } })))
      .toEqual({ kind: 'held', reason: 'policy_unconfirmed' });
    expect(evaluateAutomaticRelease(input({ freshness: { kind: 'confirmed', policyVersion: 2, generation: 2 } })))
      .toEqual({ kind: 'held', reason: 'policy_unconfirmed' });
  });

  it('holds events from a disallowed peer or the recipient agent itself', () => {
    expect(evaluateAutomaticRelease(input({ event: event('event_1', OTHER_PEER) })))
      .toEqual({ kind: 'held', reason: 'peer_not_allowed' });
    const selfScoped = effectiveAuto({ peerParticipantId: OWN_AGENT });
    expect(evaluateAutomaticRelease(input({ state: selfScoped, event: event('event_1', OWN_AGENT) })))
      .toEqual({ kind: 'held', reason: 'peer_not_allowed' });
  });

  it('holds when the binding changed underneath the policy', () => {
    expect(evaluateAutomaticRelease(input({ binding: binding(2) }))).toEqual({ kind: 'held', reason: 'stale_binding' });
    expect(evaluateAutomaticRelease(input({ binding: { ...binding(), bindingId: 'binding_2' as typeof BINDING } })))
      .toEqual({ kind: 'held', reason: 'stale_binding' });
  });

  it('holds backlog that arrived before auto became effective', () => {
    expect(evaluateAutomaticRelease(input({ arrivedUnderPolicyVersion: 1 }))).toEqual({ kind: 'held', reason: 'backlog' });
  });

  it('holds when automation limits are not approved', () => {
    expect(evaluateAutomaticRelease(input({ automation: null }))).toEqual({ kind: 'held', reason: 'automation_gated' });
  });

  it('holds at the causal depth limit and when the budget is exhausted, with a content-free reason', () => {
    expect(evaluateAutomaticRelease(input({ causal: { rootId: causalRoot, depth: 3 } })))
      .toEqual({ kind: 'held', reason: 'loop_limit' });
    expect(evaluateAutomaticRelease(input({ causal: { rootId: causalRoot, depth: 2 } })).kind).toBe('release');

    const exhausted = evaluateAutomaticRelease(input({ budgetRemaining: 0 }));
    expect(exhausted).toEqual({ kind: 'held', reason: 'budget_exhausted' });
    expect(Object.keys(exhausted)).toEqual(['kind', 'reason']);
  });

  it('returns the existing release identity for a duplicate event instead of minting another', () => {
    const decision = evaluateAutomaticRelease(input({ priorReleaseId: releaseId('release_0'), releaseId: releaseId('release_9') }));

    expect(decision).toEqual({ kind: 'duplicate', releaseId: 'release_0' });
  });

  it('gives a model-issued policy command no authority to enable auto', () => {
    const change = evaluatePolicyChange(start(), { kind: 'model', bindingId: BINDING }, command(), AUTOMATION);
    const forged = applyPolicyAck(change.state, ack());

    expect(change.outcome).toEqual({ ok: false, code: 'forbidden' });
    expect(forged.outcome).toEqual({ applied: false, reason: 'unknown_command' });
    expect(evaluateAutomaticRelease(input({ state: forged.state, freshness: { kind: 'confirmed', policyVersion: 1, generation: 1 } })))
      .toEqual({ kind: 'held', reason: 'not_auto' });
  });

  it('never releases for a peer other than the one named by the effective revision', () => {
    expect(PEER).not.toBe(OTHER_PEER);
    const scopedToOther = effectiveAuto({ peerParticipantId: OTHER_PEER });
    expect(evaluateAutomaticRelease(input({ state: scopedToOther }))).toEqual({ kind: 'held', reason: 'peer_not_allowed' });
  });
});
