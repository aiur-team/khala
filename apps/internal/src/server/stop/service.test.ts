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
}>, calls: Calls = []): BindingStopPorts {
  const barrier = createRevocationBarrier();
  return {
    barrier: {
      ...barrier,
      raise: key => { calls.push(`raise:${key.bindingId}`); barrier.raise(key); },
      drain: async key => { calls.push(`drain:${key.bindingId}`); await barrier.drain(key); },
    },
    candidates: () => input.candidates,
    revoke: key => { calls.push(`revoke:${key.bindingId}`); return input.revoke?.(key) ?? 'revoked'; },
    dropCapability: key => { calls.push(`drop:${key.bindingId}`); },
    ...(input.clearGrant ? { clearGrant: input.clearGrant } : {}),
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
      'raise:binding-bob', 'drop:binding-bob', 'raise:binding-carol', 'drop:binding-carol',
      'drain:binding-bob', 'drain:binding-carol', 'revoke:binding-bob', 'revoke:binding-carol',
    ]);
  });

  it('skips already revoked generations and reports unavailable when candidates cannot be read', async () => {
    const calls: Calls = [];
    const service = createBindingStopService(ports({
      candidates: [{ binding: bobBinding, status: 'revoked', latest: true }],
    }, calls));
    expect(await service.stop('channel-one', null)).toEqual({ kind: 'stopped', stopped: [] });
    expect(calls).toEqual([]);
    expect(await createBindingStopService(ports({ candidates: 'unavailable' })).stop('channel-one', null))
      .toEqual({ kind: 'unavailable' });
  });

  it('refuses a target that is not the newest generation', async () => {
    const service = createBindingStopService(ports({ candidates: [{ binding: bobBinding, status: 'active', latest: false }] }));
    expect(await service.stop('channel-one', [{ bindingId: 'binding-bob', generation: 1 }]))
      .toEqual({ kind: 'rejected', code: 'stale_target' });
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
