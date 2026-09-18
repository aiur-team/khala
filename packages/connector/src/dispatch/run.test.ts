import { describe, expect, it, vi } from 'vitest';
import { deferred, faultyLedger, makeRelease, receipt, recordOf, seed, testPolicy, world } from './fakes';

// With a release seeded and no dispatcher awake, one pass makes these transactions in order.
const QUEUE_READ = 1;
const CLAIM = 3;
const RECEIPT = 4;

describe('submission and receipt persistence', () => {
  it('submits the exact verified payload once and stores the correlated receipt', async () => {
    const w = await world();
    const release = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(release.job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(1);
    expect(w.harness.submitted[0]!.payload).toEqual(release.payload);
    const record = await recordOf(w.ledger, 'release-1');
    expect(record).toMatchObject({ state: 'accepted', attemptId: 'attempt-1', workerId: 'worker-1' });
    expect(record?.receipts.map(seen => seen.kind)).toEqual(['harness_queued']);
  });

  it('AE2: a lost response becomes outcome_unknown and is never submitted again', async () => {
    const w = await world();
    w.harness.onSubmit = async () => { throw new Error('socket closed'); };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    const record = await recordOf(w.ledger, 'release-1');
    expect(record).toMatchObject({ state: 'outcome_unknown' });
    expect(record?.receipts).toMatchObject([{ kind: 'outcome_unknown', source: 'connector', errorCode: 'disconnected' }]);

    dispatcher.wake();
    await dispatcher.idle();
    const restarted = w.dispatcher({ workerId: 'worker-2' });
    restarted.wake();
    await restarted.reconcile('release-1');
    await restarted.idle();
    expect(w.harness.submitted).toHaveLength(1);
  });

  it.each([
    ['transport_written', {}],
    ['outcome_unknown', { errorCode: 'timeout' as const }],
    ['failed', { errorCode: 'timeout' as const }],
    ['failed', { errorCode: 'disconnected' as const }],
  ] as const)('does not treat a %s receipt as proof either way', async (kind, extra) => {
    const w = await world();
    w.harness.onSubmit = async job => receipt(job, kind, extra);
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
  });

  it('treats an uncorrelated receipt as no evidence', async () => {
    const w = await world();
    w.harness.onSubmit = async job => receipt(job, 'harness_queued', { generation: 7 });
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    const record = await recordOf(w.ledger, 'release-1');
    expect(record).toMatchObject({ state: 'outcome_unknown' });
    expect(record?.receipts).toEqual([]);
  });

  describe('fault injection around every boundary', () => {
    async function crashing(n: number, when: 'before' | 'after') {
      const w = await world();
      const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
      await seed(w.ledger, job);
      const ledger = faultyLedger(w.ledger);
      ledger.crashAt(n, when);
      const dispatcher = w.dispatcher({ ledger });
      dispatcher.wake();
      await dispatcher.idle();
      expect(w.errors).toHaveLength(1);
      return { w, job };
    }

    it('before the queue read: nothing is claimed and a later pass dispatches', async () => {
      const { w } = await crashing(QUEUE_READ, 'before');
      expect(w.harness.submitted).toHaveLength(0);
      const restarted = w.dispatcher();
      restarted.wake();
      await restarted.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
    });

    it('before the intent commits: no reservation, no submit, and a restart dispatches once', async () => {
      const { w, job } = await crashing(CLAIM, 'before');
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', attemptId: null });
      expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);
      const restarted = w.dispatcher();
      restarted.wake();
      await restarted.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
    });

    it('after the intent commits but before the call: a restart never submits it', async () => {
      const { w } = await crashing(CLAIM, 'after');
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'dispatching' });
      const restarted = w.dispatcher({ workerId: 'worker-2' });
      restarted.wake();
      await restarted.reconcile('release-1');
      await restarted.idle();
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
    });

    it('AE2: after the call but before the receipt commits: a restart does not resubmit', async () => {
      const { w } = await crashing(RECEIPT, 'before');
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'dispatching' });
      const restarted = w.dispatcher({ workerId: 'worker-2' });
      restarted.wake();
      await restarted.reconcile('release-1');
      await restarted.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
    });

    it('during the receipt commit: the committed receipt stands', async () => {
      const { w } = await crashing(RECEIPT, 'after');
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
    });
  });
});

describe('receipt ownership and slot release', () => {
  it('never lets a receipt for another release move that release', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const first = w.add(makeRelease({ releaseId: 'release-a' }));
    await dispatcher.enqueue(first.job);
    await dispatcher.idle();
    w.harness.onSubmit = async () => receipt(first.job, 'completed');
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-b', bindingId: 'bind-2' })).job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-a')).toMatchObject({ state: 'accepted' });
    expect(await recordOf(w.ledger, 'release-b')).toMatchObject({ state: 'outcome_unknown' });

    w.harness.onReconcile = async () => receipt(first.job, 'failed', { errorCode: 'harness_rejected' });
    await dispatcher.reconcile('release-b');
    expect(await recordOf(w.ledger, 'release-a')).toMatchObject({ state: 'accepted' });
  });

  it('starts waiting work when a submission settles and frees the slot', async () => {
    const w = await world(testPolicy({ maxConcurrentJobs: 1 }));
    const gate = deferred<void>();
    w.harness.onSubmit = async job => {
      await gate.promise;
      return receipt(job, 'failed', { errorCode: 'harness_rejected' });
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' })).job);
    await vi.waitFor(async () => expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ reason: 'at_capacity' }));
    gate.resolve();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
  });

  it('refuses a second release of one approval under a fresh causal root', async () => {
    const w = await world(testPolicy({ maxJobsPerCausalRoot: 1 }));
    const dispatcher = w.dispatcher();
    const release = w.add(makeRelease({ releaseId: 'release-1', root: 'cause-1' }));
    await dispatcher.enqueue(release.job);
    await dispatcher.idle();
    const replay = { ...release.job, releaseId: 'release-1b' as never, causalRootId: 'cause-fresh' as never };
    expect(await dispatcher.enqueue(replay)).toBe('conflict');
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
  });
});
