import { describe, expect, it, vi } from 'vitest';
import type { BindingId, CommandId, RoomId } from '@khala/contracts/delivery/index';
import {
  ALICE, BINDING, MALLORY, OTHER_PEER, PEER, ack, command, owner, start,
} from '../../test/trust/fakes';
import { applyPolicyAck, applyRebind, evaluatePolicyChange, trustView } from './transitions';
import type { TrustState } from './types';

// These tests exercise transitions as they will behave once G-AUTOMATION opens,
// using example limits that are not approved values. `gate.test.ts` proves the real
// seam keeps every `auto` request refused.
vi.mock('./gate', async importOriginal => ({
  ...await importOriginal<typeof import('./gate')>(),
  approvedAutomation: () => ({ maxCausalDepth: 3 }),
}));

const id = (value: string) => value as CommandId;

/** Accepts `cmd` from `state`, failing the test if it is refused. */
function accept(state: TrustState, cmd = command()): TrustState {
  const change = evaluatePolicyChange(state, owner(), cmd, 'active');
  expect(change.outcome.ok).toBe(true);
  return change.state;
}

describe('requested and effective policy', () => {
  it('keeps an owner auto request requested until the connector acknowledges it', () => {
    const change = evaluatePolicyChange(start(), owner(), command(), 'active');

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
    const refused = evaluatePolicyChange(start(), owner(), command({ expectedPolicyVersion: 9 }), 'active').state;

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
      const change = evaluatePolicyChange(state, actor, command(), 'active');
      expect(change).toEqual({ state, outcome: { ok: false, code: 'forbidden' }, effects: [] });
    }
    // The owner can still use the command id afterwards.
    expect(evaluatePolicyChange(state, owner(ALICE), command(), 'active').outcome.ok).toBe(true);
  });

  it('refuses stale binding generation and stale policy version with no last-write-wins', () => {
    const state = start();
    expect(evaluatePolicyChange(state, owner(), command({ expectedBindingGeneration: 0 }), 'active').outcome)
      .toEqual({ ok: false, code: 'stale_binding' });

    const first = accept(state, command({ commandId: id('cmd_a') }));
    const racing = evaluatePolicyChange(first, owner(), command({ commandId: id('cmd_b'), peerParticipantId: OTHER_PEER }), 'active');
    expect(racing.outcome).toEqual({ ok: false, code: 'stale_policy' });
    expect(racing.state.requested).toEqual(first.requested);
  });

  it('refuses a command for another binding or room', () => {
    const state = start();
    expect(evaluatePolicyChange(state, owner(), command({ bindingId: 'binding_2' as BindingId }), 'active').outcome)
      .toEqual({ ok: false, code: 'binding_mismatch' });
    expect(evaluatePolicyChange(state, owner(), command({ roomId: 'room_2' as RoomId }), 'active').outcome)
      .toEqual({ ok: false, code: 'binding_mismatch' });
  });

  it('returns the original outcome for a duplicate command and refuses a changed reuse', () => {
    const first = evaluatePolicyChange(start(), owner(), command(), 'active');
    const retry = evaluatePolicyChange(first.state, owner(), command(), 'active');

    expect(retry.outcome).toBe(first.outcome);
    expect(retry.state).toBe(first.state);
    expect(retry.effects).toEqual(first.effects);

    const changed = evaluatePolicyChange(first.state, owner(), command({ peerParticipantId: OTHER_PEER }), 'active');
    expect(changed.outcome).toEqual({ ok: false, code: 'idempotency_conflict' });
  });

  it('replays a refusal for a retried refused command', () => {
    const refused = evaluatePolicyChange(start(), owner(), command({ expectedPolicyVersion: 9 }), 'active');
    const retry = evaluatePolicyChange(refused.state, owner(), command({ expectedPolicyVersion: 9 }), 'active');

    expect(retry.outcome).toEqual({ ok: false, code: 'stale_policy' });
    expect(retry.effects).toEqual([]);
  });

  it('stops re-publishing a duplicate once its revision is effective or superseded', () => {
    const requested = accept(start());
    const effective = applyPolicyAck(requested, ack()).state;
    expect(evaluatePolicyChange(effective, owner(), command(), 'active').effects).toEqual([]);
  });

  it('refuses a command naming a future binding generation', () => {
    expect(evaluatePolicyChange(start(), owner(), command({ expectedBindingGeneration: 2 }), 'active').outcome)
      .toEqual({ ok: false, code: 'stale_binding' });
  });
});

describe('connector observation', () => {
  const offlineAck = (commandId = 'cmd_1', requestedVersion = 2) =>
    ack({ commandId: id(commandId), requestedVersion, effectiveVersion: 1, connectorState: 'offline' });

  it('clears the observation when the same command becomes effective', () => {
    const offline = applyPolicyAck(accept(start()), offlineAck()).state;
    expect(offline.connector).toEqual({ commandId: 'cmd_1', state: 'offline', errorCode: null });

    expect(applyPolicyAck(offline, ack()).state.connector).toBeNull();
  });

  it('keeps the newer request\'s observation when an older request becomes effective', () => {
    const rearm = accept(accept(start()), command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }));
    const offline = applyPolicyAck(rearm, offlineAck('cmd_rearm', 3)).state;

    const olderEffective = applyPolicyAck(offline, ack());
    expect(olderEffective.outcome).toEqual({ applied: true, connectorState: 'effective' });
    expect(olderEffective.state.connector).toEqual({ commandId: 'cmd_rearm', state: 'offline', errorCode: null });
  });

  it('clears the observation when a new request replaces the one it described', () => {
    const offline = applyPolicyAck(accept(start()), offlineAck()).state;
    const rearm = accept(offline, command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }));

    expect(rearm.connector).toBeNull();
  });
});

describe('acknowledgment version checks', () => {
  it('ignores a non-effective ack whose requested version does not match the command', () => {
    const requested = accept(start());
    for (const connectorState of ['pending', 'offline', 'rejected'] as const) {
      const late = applyPolicyAck(requested, ack({ requestedVersion: 3, effectiveVersion: 1, connectorState }));
      expect(late.outcome).toEqual({ applied: false, reason: 'version_mismatch' });
      expect(late.state).toBe(requested);
    }
  });

  it('ignores an effective ack whose effective version does not match the command', () => {
    const requested = accept(start());
    for (const effectiveVersion of [1, 3, null]) {
      const wrong = applyPolicyAck(requested, ack({ requestedVersion: 2, effectiveVersion }));
      expect(wrong.outcome).toEqual({ applied: false, reason: 'version_mismatch' });
      expect(wrong.state).toBe(requested);
    }
    expect(applyPolicyAck(requested, ack({ requestedVersion: null, effectiveVersion: 2 })).outcome)
      .toEqual({ applied: true, connectorState: 'effective' });
  });
});

describe('unknown effective state', () => {
  it('does not throw on a hand-built state whose effective policy is unknown', () => {
    const unknown: TrustState = { ...accept(start()), effective: null };

    expect(trustView(unknown)).toMatchObject({ status: 'requested', effective: null });
    expect(evaluatePolicyChange(unknown, owner(), command(), 'active').effects).toHaveLength(1);
    expect(applyPolicyAck(unknown, ack()).outcome).toEqual({ applied: true, connectorState: 'effective' });
  });
});

describe('revocation', () => {
  it('refuses policy changes and re-arms on a revoked binding, without journaling them', () => {
    const auto = applyPolicyAck(accept(start()), ack()).state;
    for (const cmd of [
      command({ commandId: id('cmd_auto'), expectedPolicyVersion: 2 }),
      command({ commandId: id('cmd_rearm'), mode: 'review', expectedPolicyVersion: 2 }),
      command({ commandId: id('cmd_pause'), paused: true, expectedPolicyVersion: 2 }),
    ]) {
      const change = evaluatePolicyChange(auto, owner(), cmd, 'revoked');
      expect(change).toEqual({ state: auto, outcome: { ok: false, code: 'binding_revoked' }, effects: [] });
    }
  });

  it('refuses a replayed command on a revoked binding instead of returning its first success', () => {
    const first = evaluatePolicyChange(start(), owner(), command(), 'active');
    const replay = evaluatePolicyChange(first.state, owner(), command(), 'revoked');

    expect(replay.outcome).toEqual({ ok: false, code: 'binding_revoked' });
    expect(replay.effects).toEqual([]);
  });

  it('refuses to rebind a revoked binding, so no later policy command can apply', () => {
    const rebound = applyRebind(start(), 2, 'revoked');
    expect(rebound).toEqual({ ok: false, code: 'binding_revoked' });

    const revokedGeneration = start(2);
    expect(evaluatePolicyChange(revokedGeneration, owner(), command({ expectedBindingGeneration: 2 }), 'revoked').outcome)
      .toEqual({ ok: false, code: 'binding_revoked' });
  });
});

describe('rebind', () => {
  it('starts the new generation from a fresh review baseline with a bumped version', () => {
    const auto = applyPolicyAck(accept(start()), ack()).state;
    const rebound = applyRebind(auto, 2, 'active');

    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    expect(rebound.state.requested).toEqual({
      version: 3, generation: 2, commandId: null, mode: 'review', paused: false, peerParticipantId: null,
    });
    expect(trustView(rebound.state)).toMatchObject({ status: 'effective', effective: { mode: 'review' } });
  });

  it('refuses a rebind that does not advance the generation', () => {
    expect(applyRebind(start(2), 2, 'active')).toEqual({ ok: false, code: 'stale_binding' });
    expect(applyRebind(start(2), 1, 'active')).toEqual({ ok: false, code: 'stale_binding' });
  });

  it('refuses a rebind to a generation that is not a safe integer', () => {
    for (const generation of [Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      expect(applyRebind(start(), generation, 'active')).toEqual({ ok: false, code: 'stale_binding' });
    }
  });

  it('reports a pre-rebind command replayed after the rebind as stale, not as success', () => {
    const first = evaluatePolicyChange(start(), owner(), command(), 'active');
    const rebound = applyRebind(first.state, 2, 'active');
    if (!rebound.ok) throw new Error('rebind refused');

    const retry = evaluatePolicyChange(rebound.state, owner(), command(), 'active');
    expect(retry.outcome).toEqual({ ok: false, code: 'stale_binding' });
    expect(retry.effects).toEqual([]);
    expect(retry.state).toBe(rebound.state);
  });
});
