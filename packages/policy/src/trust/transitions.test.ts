import { describe, expect, it } from 'vitest';
import type { BindingId, CommandId, RoomId } from '@khala/contracts/delivery/index';
import {
  ALICE, AUTOMATION, BINDING, MALLORY, OTHER_PEER, PEER, ack, command, owner, start,
} from './fakes';
import { applyPolicyAck, applyRebind, evaluatePolicyChange, trustView } from './transitions';
import type { TrustState } from './types';

const id = (value: string) => value as CommandId;

/** Accepts `cmd` from `state`, failing the test if it is refused. */
function accept(state: TrustState, cmd = command()): TrustState {
  const change = evaluatePolicyChange(state, owner(), cmd, AUTOMATION);
  expect(change.outcome.ok).toBe(true);
  return change.state;
}

describe('requested and effective policy', () => {
  it('keeps an owner auto request requested until the connector acknowledges it', () => {
    const change = evaluatePolicyChange(start(), owner(), command(), AUTOMATION);

    expect(change.outcome).toMatchObject({ ok: true, requested: { version: 2, generation: 1, mode: 'auto' } });
    expect(change.effects).toEqual([
      { kind: 'publish_policy', bindingId: BINDING, revision: change.state.requested },
    ]);
    expect(trustView(change.state)).toMatchObject({
      status: 'requested', requested: { version: 2, mode: 'auto' }, effective: { version: 1, mode: 'review' },
    });

    const acked = applyPolicyAck(change.state, ack());
    expect(acked.outcome).toEqual({ applied: true, connectorState: 'effective' });
    expect(trustView(acked.state)).toMatchObject({ status: 'effective', effective: { version: 2, mode: 'auto' } });
  });

  it('reports a re-arm made while the connector is offline as requested, not effective (AE1)', () => {
    const auto = applyPolicyAck(accept(start()), ack()).state;
    const rearm = accept(auto, command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }));

    const offline = applyPolicyAck(rearm, ack({
      commandId: id('cmd_rearm'), requestedVersion: 3, effectiveVersion: 2, connectorState: 'offline',
    }));

    expect(offline.outcome).toEqual({ applied: true, connectorState: 'offline' });
    expect(trustView(offline.state)).toEqual({
      requested: { version: 3, mode: 'review', paused: false },
      effective: { version: 2, mode: 'auto', paused: false },
      status: 'requested',
      connectorState: 'offline',
    });

    const reconnected = applyPolicyAck(offline.state, ack({ commandId: id('cmd_rearm'), requestedVersion: 3, effectiveVersion: 3 }));
    expect(trustView(reconnected.state)).toMatchObject({
      status: 'effective', effective: { version: 3, mode: 'review' }, connectorState: null,
    });
  });

  it('surfaces a connector rejection without claiming the request took effect', () => {
    const requested = accept(start());
    const rejected = applyPolicyAck(requested, ack({
      requestedVersion: 2, effectiveVersion: 1, connectorState: 'rejected', errorCode: 'stale_policy',
    }));

    expect(trustView(rejected.state)).toMatchObject({ status: 'rejected', effective: { version: 1, mode: 'review' } });
    expect(rejected.state.connector).toEqual({ commandId: 'cmd_1', state: 'rejected', errorCode: 'stale_policy' });
  });

  it('pauses and resumes only through owner commands', () => {
    const auto = applyPolicyAck(accept(start()), ack()).state;
    const pause = accept(auto, command({ commandId: id('cmd_pause'), paused: true, expectedPolicyVersion: 2 }));
    const paused = applyPolicyAck(pause, ack({ commandId: id('cmd_pause'), requestedVersion: 3, effectiveVersion: 3 })).state;
    expect(trustView(paused)).toMatchObject({ status: 'effective', effective: { mode: 'auto', paused: true } });

    const resume = accept(paused, command({
      commandId: id('cmd_resume'), mode: 'review', paused: false, expectedPolicyVersion: 3,
    }));
    expect(trustView(resume)).toMatchObject({ status: 'requested', requested: { mode: 'review', paused: false } });
  });
});

describe('late and mismatched acknowledgments', () => {
  it('does not let an old ack roll back a newer effective policy', () => {
    const auto = accept(start());
    const rearm = accept(auto, command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }));
    const current = applyPolicyAck(rearm, ack({ commandId: id('cmd_rearm'), requestedVersion: 3, effectiveVersion: 3 })).state;

    const late = applyPolicyAck(current, ack());

    expect(late.outcome).toEqual({ applied: false, reason: 'superseded' });
    expect(late.state).toBe(current);
    expect(trustView(late.state)).toMatchObject({ status: 'effective', effective: { version: 3, mode: 'review' } });
  });

  it('records an older request the connector really enforced while keeping the newer one requested', () => {
    const auto = accept(start());
    const rearm = accept(auto, command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }));

    const olderEffective = applyPolicyAck(rearm, ack());

    expect(olderEffective.outcome).toEqual({ applied: true, connectorState: 'effective' });
    expect(trustView(olderEffective.state)).toMatchObject({
      status: 'requested', requested: { version: 3, mode: 'review' }, effective: { version: 2, mode: 'auto' },
    });
  });

  it('ignores an older request\'s pending ack once a newer request exists', () => {
    const auto = accept(start());
    const rearm = accept(auto, command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }));

    const late = applyPolicyAck(rearm, ack({ requestedVersion: 2, effectiveVersion: 1, connectorState: 'pending' }));

    expect(late.outcome).toEqual({ applied: false, reason: 'superseded' });
  });

  it('rejects an otherwise identical ack for another generation, binding or command', () => {
    const requested = accept(start());

    expect(applyPolicyAck(requested, ack({ generation: 2 })).outcome).toEqual({ applied: false, reason: 'stale_generation' });
    expect(applyPolicyAck(requested, ack({ bindingId: 'binding_2' as BindingId })).outcome)
      .toEqual({ applied: false, reason: 'binding_mismatch' });
    expect(applyPolicyAck(requested, ack({ commandId: id('cmd_unknown') })).outcome)
      .toEqual({ applied: false, reason: 'unknown_command' });
    expect(applyPolicyAck(requested, ack({ requestedVersion: 7, effectiveVersion: 7 })).outcome)
      .toEqual({ applied: false, reason: 'version_mismatch' });
  });

  it('does not treat an ack for a refused command as effective', () => {
    const refused = evaluatePolicyChange(start(), owner(), command({ expectedPolicyVersion: 9 }), AUTOMATION).state;

    expect(applyPolicyAck(refused, ack()).outcome).toEqual({ applied: false, reason: 'unknown_command' });
  });
});

describe('policy change authority and concurrency', () => {
  it('refuses a wrong owner, a peer and a model without journaling the command', () => {
    const state = start();
    for (const actor of [
      owner(MALLORY),
      { kind: 'peer', participantId: PEER } as const,
      { kind: 'model', bindingId: BINDING } as const,
    ]) {
      const change = evaluatePolicyChange(state, actor, command(), AUTOMATION);
      expect(change).toEqual({ state, outcome: { ok: false, code: 'forbidden' }, effects: [] });
    }
    // The owner can still use the command id afterwards.
    expect(evaluatePolicyChange(state, owner(ALICE), command(), AUTOMATION).outcome.ok).toBe(true);
  });

  it('refuses stale binding generation and stale policy version with no last-write-wins', () => {
    const state = start();
    expect(evaluatePolicyChange(state, owner(), command({ expectedBindingGeneration: 0 }), AUTOMATION).outcome)
      .toEqual({ ok: false, code: 'stale_binding' });

    const first = accept(state, command({ commandId: id('cmd_a') }));
    const racing = evaluatePolicyChange(first, owner(), command({ commandId: id('cmd_b'), peerParticipantId: OTHER_PEER }), AUTOMATION);
    expect(racing.outcome).toEqual({ ok: false, code: 'stale_policy' });
    expect(racing.state.requested).toEqual(first.requested);
  });

  it('refuses a command for another binding or room', () => {
    const state = start();
    expect(evaluatePolicyChange(state, owner(), command({ bindingId: 'binding_2' as BindingId }), AUTOMATION).outcome)
      .toEqual({ ok: false, code: 'binding_mismatch' });
    expect(evaluatePolicyChange(state, owner(), command({ roomId: 'room_2' as RoomId }), AUTOMATION).outcome)
      .toEqual({ ok: false, code: 'binding_mismatch' });
  });

  it('returns the original outcome for a duplicate command and refuses a changed reuse', () => {
    const first = evaluatePolicyChange(start(), owner(), command(), AUTOMATION);
    const retry = evaluatePolicyChange(first.state, owner(), command(), AUTOMATION);

    expect(retry.outcome).toBe(first.outcome);
    expect(retry.state).toBe(first.state);
    expect(retry.effects).toEqual(first.effects);

    const changed = evaluatePolicyChange(first.state, owner(), command({ peerParticipantId: OTHER_PEER }), AUTOMATION);
    expect(changed.outcome).toEqual({ ok: false, code: 'idempotency_conflict' });
  });

  it('replays a refusal for a retried refused command', () => {
    const refused = evaluatePolicyChange(start(), owner(), command({ expectedPolicyVersion: 9 }), AUTOMATION);
    const retry = evaluatePolicyChange(refused.state, owner(), command({ expectedPolicyVersion: 9 }), AUTOMATION);

    expect(retry.outcome).toEqual({ ok: false, code: 'stale_policy' });
    expect(retry.effects).toEqual([]);
  });

  it('stops re-publishing a duplicate once its revision is effective or superseded', () => {
    const requested = accept(start());
    const effective = applyPolicyAck(requested, ack()).state;
    expect(evaluatePolicyChange(effective, owner(), command(), AUTOMATION).effects).toEqual([]);
  });

  it('refuses auto without approved automation limits but still allows review and pause', () => {
    const state = start();
    for (const automation of [null, { maxCausalDepth: 0 }, { maxCausalDepth: 1.5 }]) {
      expect(evaluatePolicyChange(state, owner(), command(), automation).outcome)
        .toEqual({ ok: false, code: 'automation_gated' });
    }
    expect(evaluatePolicyChange(state, owner(), command({ mode: 'review', paused: true }), null).outcome.ok).toBe(true);
  });
});

describe('rebind', () => {
  it('starts the new generation from a fresh review baseline with a bumped version', () => {
    const auto = applyPolicyAck(accept(start()), ack()).state;
    const rebound = applyRebind(auto, 2);

    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    expect(rebound.state.requested).toEqual({
      version: 3, generation: 2, commandId: null, mode: 'review', paused: false, peerParticipantId: null,
    });
    expect(trustView(rebound.state)).toMatchObject({ status: 'effective', effective: { mode: 'review' } });
  });

  it('refuses a rebind that does not advance the generation', () => {
    expect(applyRebind(start(2), 2)).toEqual({ ok: false, code: 'stale_binding' });
    expect(applyRebind(start(2), 1)).toEqual({ ok: false, code: 'stale_binding' });
  });

  it('leaves a retried pre-rebind command with its original outcome but no publish effect', () => {
    const first = evaluatePolicyChange(start(), owner(), command(), AUTOMATION);
    const rebound = applyRebind(first.state, 2);
    if (!rebound.ok) throw new Error('rebind refused');

    const retry = evaluatePolicyChange(rebound.state, owner(), command(), AUTOMATION);
    expect(retry.outcome).toBe(first.outcome);
    expect(retry.effects).toEqual([]);
    expect(retry.state.requested.mode).toBe('review');
  });
});
