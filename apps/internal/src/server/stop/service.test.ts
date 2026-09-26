import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { bobBinding, carolBinding } from '../fixtures/channel-fixture';
import { type BindingKey, createRevocationBarrier } from './barrier';
import { type BindingStopPorts, type StopCandidate, createBindingStopService } from './service';

describe('revocation barrier', () => {
  it('bars new commits at once and drains effects that were already committing', async () => {
    const barrier = createRevocationBarrier();
    let finish: () => void = () => {};
    const committing = barrier.run(bobBinding, () => new Promise<void>(resolve => { finish = resolve; }));
    expect(committing.kind).toBe('ran');

    barrier.raise(bobBinding);
    expect(barrier.run(bobBinding, () => 'late')).toEqual({ kind: 'barred' });
    // Another binding, and another generation of the same binding, are untouched.
    expect(barrier.run(carolBinding, () => 'carol')).toEqual({ kind: 'ran', value: 'carol' });
    expect(barrier.run({ ...bobBinding, generation: 2 }, () => 'next')).toEqual({ kind: 'ran', value: 'next' });

    let drained = false;
    const draining = barrier.drain(bobBinding).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
  });

  it('treats a failed in-flight effect as settled', async () => {
    const barrier = createRevocationBarrier();
    const failing = barrier.run(bobBinding, () => Promise.reject(new Error('write failed')));
    if (failing.kind === 'ran') await failing.value.catch(() => {});
    barrier.raise(bobBinding);
    await expect(barrier.drain(bobBinding)).resolves.toBeUndefined();
  });

  it('ends registered streams when raised, and immediately when registered late', () => {
    const barrier = createRevocationBarrier();
    const ended: string[] = [];
    const unregister = barrier.onRaise(bobBinding, () => ended.push('kept'));
    barrier.onRaise(bobBinding, () => ended.push('second'))();
    barrier.raise(bobBinding);
    unregister();
    barrier.onRaise(bobBinding, () => ended.push('late'));
    expect(ended).toEqual(['kept', 'late']);
  });
});

type Calls = string[];

function ports(input: Readonly<{
  candidates: readonly StopCandidate[] | 'unavailable';
  revoke?: (key: BindingKey) => 'revoked' | 'failed';
  clearGrant?: BindingStopPorts['clearGrant'];
  cancelApproved?: BindingStopPorts['cancelApproved'];
  closeStopped?: BindingStopPorts['closeStopped'];
}>, calls: Calls = []): BindingStopPorts {
  const barrier = createRevocationBarrier();
  return {
    barrier: {
      ...barrier,
      raise: key => { calls.push(`raise:${key.bindingId}`); barrier.raise(key); },
      drain: async key => { calls.push(`drain:${key.bindingId}`); await barrier.drain(key); },
    },
    candidates: () => { calls.push('candidates'); return input.candidates; },
    revoke: key => { calls.push(`revoke:${key.bindingId}`); return input.revoke?.(key) ?? 'revoked'; },
    dropCapability: key => { calls.push(`drop:${key.bindingId}`); },
    ...(input.clearGrant ? { clearGrant: input.clearGrant } : {}),
    ...(input.cancelApproved ? { cancelApproved: input.cancelApproved } : {}),
    ...(input.closeStopped ? { closeStopped: input.closeStopped } : {}),
  };
}

const active = (binding: SessionBinding): StopCandidate => ({ binding, status: 'active', latest: true });

describe('binding Stop service', () => {
  it('bars and drops every binding before waiting, and revokes only after the drain', async () => {
    const calls: Calls = [];
    const service = createBindingStopService(ports({ candidates: [active(bobBinding), active(carolBinding)] }, calls));
    const result = await service.stop('channel-one', null);
    expect(result.kind).toBe('stopped');
    expect(calls).toEqual([
      'candidates', 'raise:binding-bob', 'drop:binding-bob', 'raise:binding-carol', 'drop:binding-carol',
      'drain:binding-bob', 'drain:binding-carol', 'revoke:binding-bob', 'revoke:binding-carol',
    ]);
  });

  it('skips already revoked generations and reports unavailable when candidates cannot be read', async () => {
    const calls: Calls = [];
    const service = createBindingStopService(ports({
      candidates: [{ binding: bobBinding, status: 'revoked', latest: true }],
    }, calls));
    expect(await service.stop('channel-one', null)).toEqual({ kind: 'stopped', stopped: [] });
    expect(calls).toEqual(['candidates']);
    expect(await createBindingStopService(ports({ candidates: 'unavailable' })).stop('channel-one', null))
      .toEqual({ kind: 'unavailable' });
  });

  it('closes the channel\'s approved requests before it reads the bindings to revoke', async () => {
    const calls: Calls = [];
    const service = createBindingStopService(ports({
      candidates: [active(bobBinding)],
      cancelApproved: async channelId => { calls.push(`cancel:${channelId}`); return 'cancelled'; },
    }, calls));
    expect((await service.stop('channel-one', null)).kind).toBe('stopped');
    expect(calls.slice(0, 2)).toEqual(['cancel:channel-one', 'candidates']);
    // A Stop of named bindings leaves approvals alone.
    calls.length = 0;
    await service.stop('channel-one', [{ bindingId: 'binding-bob', generation: 1, agentParticipantId: 'participant-bob' }]);
    expect(calls).not.toContain('cancel:channel-one');
  });

  it('still revokes the bindings, but never reports stopped, when approvals could not be closed', async () => {
    const calls: Calls = [];
    for (const cancelApproved of [async () => 'unavailable' as const, async () => { throw new Error('journal down'); }]) {
      calls.length = 0;
      const service = createBindingStopService(ports({ candidates: [active(bobBinding)], cancelApproved }, calls));
      expect(await service.stop('channel-one', null)).toEqual({ kind: 'unavailable' });
      expect(calls).toContain('revoke:binding-bob');
    }
  });

  // Wrong-implementation test (#441): closing requests before the revocations, or only for
  // bindings revoked in this attempt, leaves a stopped request reading as connected.
  it('closes the requests of every revoked binding after revoking them, retried whole until it can', async () => {
    const calls: Calls = [];
    let answer: 'closed' | 'unavailable' = 'unavailable';
    const closeStopped = async (ids: ReadonlySet<string>) => { calls.push(`close:${[...ids].sort().join(',')}`); return answer; };
    const service = createBindingStopService(ports({
      candidates: [active(bobBinding), { binding: carolBinding, status: 'revoked', latest: true }],
      revoke: key => (key.bindingId === 'binding-bob' ? 'revoked' : 'failed'),
      closeStopped,
    }, calls));
    expect(await service.stop('channel-one', null)).toEqual({ kind: 'unavailable' });
    // Carol's binding was revoked by an earlier partial Stop; its request is closed too.
    expect(calls.indexOf('close:binding-bob,binding-carol')).toBeGreaterThan(calls.indexOf('revoke:binding-bob'));

    answer = 'closed';
    expect((await service.stop('channel-one', null)).kind).toBe('stopped');
    const failing = createBindingStopService(ports({
      candidates: [active(bobBinding)], revoke: () => 'failed', closeStopped,
    }, calls));
    calls.length = 0;
    // A binding whose revocation failed keeps its request.
    expect((await failing.stop('channel-one', null)).kind).toBe('partial');
    expect(calls).toContain('close:');
  });

  it('refuses a target that is not the newest generation', async () => {
    const service = createBindingStopService(ports({ candidates: [{ binding: bobBinding, status: 'active', latest: false }] }));
    expect(await service.stop('channel-one', [{ bindingId: 'binding-bob', generation: 1, agentParticipantId: 'participant-bob' }]))
      .toEqual({ kind: 'rejected', code: 'stale_target' });
  });

  it('refuses a target recorded for another participant before barring or revoking anything', async () => {
    const calls: Calls = [];
    const service = createBindingStopService(ports({ candidates: [active(bobBinding), active(carolBinding)] }, calls));
    const result = await service.stop('channel-one', [
      { bindingId: 'binding-bob', generation: 1, agentParticipantId: 'participant-bob' },
      { bindingId: 'binding-carol', generation: 1, agentParticipantId: 'participant-bob' },
    ]);
    expect(result).toEqual({ kind: 'rejected', code: 'participant_mismatch' });
    expect(calls).toEqual(['candidates']);
  });

  it('never reports a binding as stopped while the descriptor may still grant it', async () => {
    const service = createBindingStopService(ports({ candidates: [active(bobBinding)], clearGrant: () => 'failed' }));
    const result = await service.stop('channel-one', null);
    expect(result).toEqual({
      kind: 'partial',
      stopped: [],
      remaining: [{ bindingId: 'binding-bob', generation: 1, harness: 'codex', agentParticipantId: 'participant-bob', reason: 'descriptor_pending' }],
    });
  });

  it('clears the descriptor grant for the channel bindings it stopped, not for failed ones', async () => {
    const cleared: string[][] = [];
    const service = createBindingStopService(ports({
      candidates: [active(bobBinding), active(carolBinding)],
      revoke: key => (key.bindingId === 'binding-carol' ? 'failed' : 'revoked'),
      clearGrant: ids => { cleared.push([...ids]); return 'cleared'; },
    }));
    const result = await service.stop('channel-one', null);
    expect(result.kind).toBe('partial');
    expect(cleared).toEqual([['binding-bob']]);
  });

  it('runs Stops of one channel one at a time', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    let first = true;
    const service = createBindingStopService({
      ...ports({ candidates: [active(bobBinding)] }),
      candidates: () => [active(bobBinding)],
      barrier: {
        ...createRevocationBarrier(),
        async drain() {
          if (first) {
            first = false;
            order.push('first:drain');
            await gate;
          } else {
            order.push('second:drain');
          }
        },
      },
    });
    const one = service.stop('channel-one', null).then(() => order.push('first:done'));
    const two = service.stop('channel-one', null).then(() => order.push('second:done'));
    await Promise.resolve();
    release();
    await Promise.all([one, two]);
    expect(order).toEqual(['first:drain', 'first:done', 'second:drain', 'second:done']);
  });
});
