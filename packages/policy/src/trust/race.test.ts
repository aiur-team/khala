import { describe, expect, it, vi } from 'vitest';
import {
  type ApprovalCommand, type CommandId, type EventRef, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { type AutomaticReleaseInput, evaluateAutomaticRelease } from './automatic';
import {
  ROOM, ack, binding, causalRoot, command, event, owner, releaseId, start,
} from '../../test/trust/fakes';
import { applyPolicyAck, applyRebind, evaluatePolicyChange, trustView } from './transitions';
import type { TrustState } from './types';

// These tests exercise races as they will behave once G-AUTOMATION opens, using
// example limits that are not approved values. `gate.test.ts` proves the real seam
// keeps every `auto` request refused and every event held.
vi.mock('./gate', async importOriginal => ({
  ...await importOriginal<typeof import('./gate')>(),
  approvedAutomation: () => ({ maxCausalDepth: 3 }),
}));

const id = (value: string) => value as CommandId;

function release(state: TrustState | null, overrides: Partial<AutomaticReleaseInput> = {}) {
  return evaluateAutomaticRelease({
    state,
    freshness: { kind: 'confirmed', policyVersion: state?.requested.version ?? 0, generation: state?.generation ?? 0 },
    bindingStatus: 'active',
    binding: binding(state?.generation ?? 1),
    event: event(),
    arrivedUnderPolicyVersion: state?.effective?.version ?? 0,
    causal: { rootId: causalRoot, depth: 0 },
    budgetRemaining: 1,
    priorReleaseId: null,
    releaseId: releaseId(),
    ...overrides,
  });
}

function approval(selection: readonly EventRef[], expectedPolicyVersion: number): ApprovalCommand {
  return {
    v: 1,
    commandId: id('approve_backlog'),
    roomId: ROOM,
    bindingId: binding().bindingId,
    expectedPolicyVersion,
    expectedBindingGeneration: 1,
    selection,
    issuedAt: '2026-09-18T10:00:00Z',
  };
}

const envelope = {
  releaseId: releaseId('release_backlog'),
  payloadRef: 'ledger-entry-1',
  payloadDigest: `sha256:${'b'.repeat(64)}`,
  causalRootId: causalRoot,
};

describe('races', () => {
  it('cannot activate trust for a new generation when a rebind lands between request and ack', () => {
    const requested = evaluatePolicyChange(start(), owner(), command(), 'active').state;
    const rebound = applyRebind(requested, 2, 'active');
    if (!rebound.ok) throw new Error('rebind refused');

    // The connector acknowledges the old generation's request, and a forged copy
    // claims the new generation with the same command and version.
    const oldAck = applyPolicyAck(rebound.state, ack());
    const sameVersionNewGeneration = applyPolicyAck(rebound.state, ack({ generation: 2, requestedVersion: 2, effectiveVersion: 2 }));

    expect(oldAck.outcome).toEqual({ applied: false, reason: 'stale_generation' });
    expect(sameVersionNewGeneration.outcome).toEqual({ applied: false, reason: 'stale_generation' });
    expect(trustView(rebound.state)).toMatchObject({ effective: { mode: 'review' }, requested: { mode: 'review' } });
    expect(release(rebound.state)).toEqual({ kind: 'held', reason: 'not_auto' });
  });

  it('holds on budget exhaustion without exposing content', () => {
    const effective = applyPolicyAck(evaluatePolicyChange(start(), owner(), command(), 'active').state, ack()).state;
    const first = release(effective, { budgetRemaining: 1 });
    expect(first).toMatchObject({ kind: 'release', budgetRemaining: 0 });

    const second = release(effective, { event: event('event_2'), budgetRemaining: 0, releaseId: releaseId('release_2') });
    expect(second).toEqual({ kind: 'held', reason: 'budget_exhausted' });
  });

  it('holds after a restart with missing policy until state is reconciled', () => {
    expect(release(null)).toEqual({ kind: 'held', reason: 'policy_unknown' });
    const reconnectedUnconfirmed = applyPolicyAck(
      evaluatePolicyChange(start(), owner(), command(), 'active').state, ack(),
    ).state;
    expect(release(reconnectedUnconfirmed, { freshness: { kind: 'unconfirmed' } }))
      .toEqual({ kind: 'held', reason: 'policy_unconfirmed' });
  });

  it('two owner tabs racing on the same version: one wins, the other must refresh', () => {
    const state = start();
    const tabA = evaluatePolicyChange(state, owner(), command({ commandId: id('tab_a'), mode: 'review', paused: true }), 'active');
    const tabB = evaluatePolicyChange(tabA.state, owner(), command({ commandId: id('tab_b') }), 'active');

    expect(tabA.outcome.ok).toBe(true);
    expect(tabB.outcome).toEqual({ ok: false, code: 'stale_policy' });
    expect(tabB.state.requested.commandId).toBe('tab_a');
  });
});

describe('backlog is a separate explicit choice', () => {
  const backlog = [event('event_old_1'), event('event_old_2')];

  it('future-only activation releases nothing that was already pending', () => {
    const effective = applyPolicyAck(evaluatePolicyChange(start(), owner(), command(), 'active').state, ack()).state;

    for (const pending of backlog) {
      expect(release(effective, { event: pending, arrivedUnderPolicyVersion: 1 })).toEqual({ kind: 'held', reason: 'backlog' });
    }
    expect(release(effective, { event: event('event_new') }).kind).toBe('release');
  });

  it('releases a chosen backlog through exact approval, then activates; new events stay out of the selection', () => {
    const backlogRelease = releaseFromApproval({
      approval: approval(backlog, 1), items: backlog, binding: binding(), policyVersion: 1, release: envelope,
    });
    expect(backlogRelease.ok).toBe(true);
    if (backlogRelease.ok) expect(backlogRelease.value.events).toEqual(backlog);

    const activated = applyPolicyAck(evaluatePolicyChange(start(), owner(), command(), 'active').state, ack()).state;
    const arriving = release(activated, { event: event('event_new') });
    expect(arriving).toMatchObject({ kind: 'release', spec: { events: [event('event_new')] } });

    // A new event cannot join the approved selection after the fact.
    expect(releaseFromApproval({
      approval: approval(backlog, 1), items: [...backlog, event('event_new')], binding: binding(), policyVersion: 1,
      release: envelope,
    })).toMatchObject({ ok: false, code: 'selection_mismatch' });
  });

  it('reports activation and backlog approval as two outcomes when the second fails', () => {
    const activation = evaluatePolicyChange(start(), owner(), command(), 'active');
    const effective = applyPolicyAck(activation.state, ack()).state;

    // The backlog approval was reviewed against version 1; activation moved it to 2.
    const backlogRelease = releaseFromApproval({
      approval: approval(backlog, 1), items: backlog, binding: binding(), policyVersion: effective.requested.version,
      release: envelope,
    });

    expect(activation.outcome.ok).toBe(true);
    expect(backlogRelease).toMatchObject({ ok: false, code: 'stale_policy' });
    expect(trustView(effective)).toMatchObject({ status: 'effective', effective: { mode: 'auto' } });
    for (const pending of backlog) {
      expect(release(effective, { event: pending, arrivedUnderPolicyVersion: 1 })).toEqual({ kind: 'held', reason: 'backlog' });
    }
  });
});
