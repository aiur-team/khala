import { describe, expect, it } from 'vitest';
import type { DeliveryReceipt } from '@khala/contracts/delivery/index';
import { deferred, faultyLedger, makeRelease, receipt, recordOf, seed, world } from './fakes';

async function dispatchingWithoutReceipt() {
  const w = await world();
  const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
  await seed(w.ledger, job);
  const ledger = faultyLedger(w.ledger);
  ledger.crashAt(4, 'before');
  const crashed = w.dispatcher({ ledger });
  crashed.wake();
  await crashed.idle();
  expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'dispatching' });
  return { w, job, restarted: w.dispatcher({ workerId: 'worker-2' }) };
}

describe('restart reconciliation', () => {
  it('records native evidence of acceptance for an unfinished intent', async () => {
    const { w, job, restarted } = await dispatchingWithoutReceipt();
    w.harness.onReconcile = async found => receipt(found, 'harness_queued');
    await restarted.reconcile('release-1');
    const record = await recordOf(w.ledger, 'release-1');
    expect(record).toMatchObject({ state: 'accepted' });
    expect(record?.receipts.map(seen => seen.releaseId)).toEqual([job.releaseId]);
    expect(w.harness.submitted).toHaveLength(1);
  });

  it('keeps an empty or failed harness lookup unknown rather than failed', async () => {
    const { w, restarted } = await dispatchingWithoutReceipt();
    w.harness.onReconcile = async () => { throw new Error('harness down'); };
    await restarted.reconcile('release-1');
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
    w.harness.onReconcile = async () => null;
    await restarted.reconcile('release-1');
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
  });

  it('resolves an unknown outcome when evidence arrives later', async () => {
    const { w, restarted } = await dispatchingWithoutReceipt();
    await restarted.reconcile('release-1');
    w.harness.onReconcile = async found => receipt(found, 'completed');
    await restarted.reconcile('release-1');
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'completed' });
    expect(w.harness.submitted).toHaveLength(1);
  });

  it('leaves a submission this instance is still making to that submission', async () => {
    const w = await world();
    const pending = deferred<DeliveryReceipt>();
    w.harness.onSubmit = () => pending.promise;
    let lookups = 0;
    w.harness.onReconcile = async () => { lookups += 1; return null; };
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    while (w.harness.submitted.length === 0) await new Promise(resolve => setTimeout(resolve, 0));

    await dispatcher.reconcile('release-1');
    expect(lookups).toBe(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'dispatching' });
    pending.resolve(receipt(job, 'harness_queued'));
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
  });

  it('ignores releases that were never dispatched', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await seed(w.ledger, job);
    const dispatcher = w.dispatcher();
    await dispatcher.reconcile('release-1');
    await dispatcher.reconcile('release-missing');
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued' });
    expect(w.harness.submitted).toHaveLength(0);
  });
});

describe('later observations', () => {
  it('stores each receipt once and never moves a settled job backwards', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();

    expect(await dispatcher.observe(receipt(job, 'context_consumed'))).toBe(true);
    expect(await dispatcher.observe(receipt(job, 'completed'))).toBe(true);
    expect(await dispatcher.observe(receipt(job, 'completed'))).toBe(true);
    expect(await dispatcher.observe(receipt(job, 'harness_queued', { receiptId: 'late' as never }))).toBe(true);
    await dispatcher.idle();
    const record = await recordOf(w.ledger, 'release-1');
    expect(record?.state).toBe('completed');
    expect(record?.receipts.map(seen => seen.kind)).toEqual(['harness_queued', 'context_consumed', 'completed', 'harness_queued']);
  });

  it('refuses receipts for another generation or an undispatched release', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await dispatcher.observe(receipt(job, 'completed', { generation: 1 }))).toBe(false);

    const queued = makeRelease({ releaseId: 'release-2' });
    await seed(w.ledger, queued.job);
    expect(await dispatcher.observe(receipt(queued.job, 'completed'))).toBe(false);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', receipts: [] });
  });

  it('abandons only an unknown outcome', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await dispatcher.abandon('release-1')).toBe(false);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
  });
});
