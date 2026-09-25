import { describe, expect, it } from 'vitest';
import {
  deferred, makeRelease, ownerAuthority, receipt, recordOf, seed, testLimits, testPolicy, world,
} from './fixtures/fakes';
import type { DeliveryReceipt } from '@khala/contracts/delivery/index';

describe('budget and causal accounting', () => {
  it('blocks the third dispatch under one causal root at maxJobsPerCausalRoot=2', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxJobsPerCausalRoot: 2 }));
    const dispatcher = w.dispatcher();
    // A→B, B's reply and A's next reply all keep the trusted root `cause-1`.
    for (const [releaseId, bindingId] of [['a-to-b', 'bind-2'], ['b-to-a', 'bind-1'], ['a-to-b-2', 'bind-2']] as const) {
      await dispatcher.enqueue(w.add(makeRelease({ releaseId, bindingId, root: 'cause-1' })).job);
      await dispatcher.idle();
      // Each turn finishes before the next reply, so only the causal budget can block.
      const done = w.harness.submitted.at(-1)?.job;
      if (done?.releaseId === releaseId) await dispatcher.observe(receipt(done, 'completed'));
      await dispatcher.idle();
    }
    expect(w.harness.submittedIds()).toEqual(['a-to-b', 'b-to-a']);
    expect(await recordOf(w.ledger, 'a-to-b-2')).toMatchObject({ state: 'queued', reason: 'budget_exhausted' });
    expect(await w.ledger.transact(tx => tx.causalCount('cause-1' as never))).toBe(2);
  });

  it('keeps counters across a restart and never lets a release rewrite its root', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxJobsPerCausalRoot: 1 }));
    const first = w.dispatcher();
    await first.enqueue(w.add(makeRelease({ releaseId: 'release-1', root: 'cause-1' })).job);
    await first.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await w.ledger.transact(tx => tx.causalCount('cause-1' as never))).toBe(1);
    await first.stop();

    const restarted = w.dispatcher({ workerId: 'worker-2' });
    const second = w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', root: 'cause-1' }));
    await restarted.enqueue(second.job);
    // The same release cannot come back under a fresh root.
    expect(await restarted.enqueue({ ...second.job, causalRootId: 'cause-fresh' as never })).toBe('conflict');
    await restarted.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'budget_exhausted' });
  });

  it('reserves once however many times it is woken', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await seed(w.ledger, job);
    const dispatcher = w.dispatcher();
    for (let i = 0; i < 5; i += 1) dispatcher.wake();
    await dispatcher.idle();
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(1);
  });

  it('grants the last allowance to only one of two concurrent dispatchers', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxJobsPerCausalRoot: 1 }));
    await seed(w.ledger, w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1' })).job);
    await seed(w.ledger, w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' })).job);
    const a = w.dispatcher({ workerId: 'worker-a' });
    const b = w.dispatcher({ workerId: 'worker-b' });
    a.wake();
    b.wake();
    await Promise.all([a.idle(), b.idle()]);
    expect(w.harness.submitted).toHaveLength(1);
    expect(await w.ledger.transact(tx => tx.causalCount('cause-1' as never))).toBe(1);
  });

  it('does not refund an unknown outcome, even after the owner abandons it', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxJobsPerCausalRoot: 1 }));
    w.harness.onSubmit = async () => { throw new Error('connection reset'); };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });

    expect(await dispatcher.abandon(ownerAuthority(), 'release-1')).toBe(true);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'abandoned' });
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'budget_exhausted' });
  });

  it('does not refund a definitive harness rejection', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxJobsPerCausalRoot: 1 }));
    w.harness.onSubmit = async job => receipt(job, 'failed', { errorCode: 'harness_rejected' });
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'failed' });
    expect(await w.ledger.transact(tx => tx.causalCount('cause-1' as never))).toBe(1);
  });

  it('holds work at the concurrency limit until an active job completes', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxConcurrentJobs: 1 }));
    const pending = deferred<DeliveryReceipt>();
    w.harness.onSubmit = job => (job.releaseId === 'release-1' ? pending.promise : Promise.resolve(receipt(job, 'harness_queued')));
    const dispatcher = w.dispatcher();
    const one = w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1', root: 'cause-1' })).job;
    await dispatcher.enqueue(one);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', root: 'cause-2' })).job);
    await tick();
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'at_capacity' });

    pending.resolve(receipt(one, 'harness_queued'));
    await tick();
    // Accepted is still active until the harness reports completion.
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await dispatcher.observe(receipt(one, 'completed'))).toBe(true);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
  });

  describe('busy session', () => {
    async function twoForOneBinding(busy: 'queue' | 'wait' | 'reject', harnessBusy: 'queue' | 'reject' = 'queue') {
      const w = await world(testPolicy(), undefined, testLimits({ busy }));
      w.harness.busy = harnessBusy;
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2' })).job);
      await dispatcher.idle();
      return w;
    }

    it('queues behind active work when the policy and harness route both queue', async () => {
      const w = await twoForOneBinding('queue');
      expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
    });

    it('waits when the policy queues but the harness route cannot', async () => {
      const w = await twoForOneBinding('queue', 'reject');
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'busy' });
    });

    it('waits under a wait policy', async () => {
      const w = await twoForOneBinding('wait');
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'busy' });
    });

    it('rejects under a reject policy', async () => {
      const w = await twoForOneBinding('reject');
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'rejected', reason: 'busy' });
    });
  });
});

/** Lets queued microtasks and ledger transactions run. */
async function tick(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}
