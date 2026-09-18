import { describe, expect, it } from 'vitest';
import type { DeliveryReceipt, OwnerAuthority } from '@khala/contracts/delivery/index';
import {
  deferred, faultyLedger, makeRelease, ownerAuthority, receipt, recordOf, seed, testPolicy, world,
} from './fixtures/fakes';
import { markUnknown } from './reconcile';
import { MAX_RECEIPTS } from './types';

async function dispatchingWithoutReceipt() {
  const w = await world();
  const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
  await seed(w.ledger, job);
  const ledger = faultyLedger(w.ledger);
  // Both the receipt commit and the fallback to outcome_unknown fail, as in a crash.
  ledger.crashAt(4, 'before');
  ledger.crashAt(5, 'before');
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

  it('refuses a receipt from another binding', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await dispatcher.observe(receipt(job, 'completed', { bindingId: 'bind-2' as never }))).toBe(false);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
  });

  it.each([
    ['an unknown outcome', 'outcome_unknown', { errorCode: 'timeout' as const }],
    ['a cancel request', 'cancel_requested', {}],
    ['a transport write', 'transport_written', {}],
  ] as const)('keeps an accepted job accepted after %s', async (_, kind, extra) => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await dispatcher.observe(receipt(job, kind, extra))).toBe(true);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
  });

  it('refuses malformed input and a changed receipt under a stored receipt ID', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await dispatcher.observe({ kind: 'completed', releaseId: job.releaseId })).toBe(false);
    expect(await dispatcher.observe(receipt(job, 'completed', { errorCode: 'timeout' }))).toBe(false);
    expect(await dispatcher.observe(receipt(job, 'harness_queued'))).toBe(true);
    expect(await dispatcher.observe(receipt(job, 'harness_queued', { evidenceRef: 'codex:other' }))).toBe(false);
    expect(await dispatcher.observe(receipt(job, 'completed', { receiptId: `receipt-${job.releaseId}-harness_queued` as never }))).toBe(false);
    const record = await recordOf(w.ledger, 'release-1');
    expect(record?.state).toBe('accepted');
    expect(record?.receipts).toEqual([receipt(job, 'harness_queued')]);
  });

  it(`keeps at most ${MAX_RECEIPTS} receipts per record`, async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    for (let i = 1; i < MAX_RECEIPTS; i += 1) {
      expect(await dispatcher.observe(receipt(job, 'context_consumed', { receiptId: `seen-${i}` as never }))).toBe(true);
    }
    expect(await dispatcher.observe(receipt(job, 'completed'))).toBe(false);
    const record = await recordOf(w.ledger, 'release-1');
    expect(record?.receipts).toHaveLength(MAX_RECEIPTS);
    expect(record?.state).toBe('accepted');
  });

  it('abandons only an unknown outcome', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await dispatcher.abandon(ownerAuthority(), 'release-1')).toBe(false);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
  });
});

describe('unknown outcomes', () => {
  async function unknownOn(bindingId: string, policy = testPolicy()) {
    const w = await world(policy);
    w.harness.onSubmit = async () => { throw new Error('connection reset'); };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', bindingId, root: 'cause-1' })).job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
    w.harness.onSubmit = async job => receipt(job, 'harness_queued');
    return { w, dispatcher };
  }

  it('keeps the binding busy', async () => {
    const { w, dispatcher } = await unknownOn('bind-1', testPolicy({ busy: 'wait' }));
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-1', root: 'cause-2' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'busy' });
  });

  it('holds its concurrency slot', async () => {
    const { w, dispatcher } = await unknownOn('bind-1', testPolicy({ maxConcurrentJobs: 1 }));
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', root: 'cause-2' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'at_capacity' });
  });

  it.each([
    ['another owner', ownerAuthority({ ownerId: 'owner-other' as never })],
    ['no authority', undefined],
    ['an authority without an authorization ID', ownerAuthority({ authorizationId: '' as never })],
  ])('refuses an abandon by %s', async (_, authority) => {
    const { w, dispatcher } = await unknownOn('bind-1');
    expect(await dispatcher.abandon(authority as OwnerAuthority, 'release-1')).toBe(false);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown', abandonedBy: null });
  });

  it('records the owner authorization that abandoned it', async () => {
    const { w, dispatcher } = await unknownOn('bind-1');
    expect(await dispatcher.abandon(ownerAuthority(), 'release-1')).toBe(true);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'abandoned', abandonedBy: 'authz-abandon-1' });
  });

  it('is only reached from the attempt that owns the intent', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await seed(w.ledger, job);
    await w.ledger.transact(tx => tx.put({ ...tx.record(job.releaseId)!, state: 'dispatching', attemptId: 'attempt-a' }));
    await w.ledger.transact(tx => markUnknown(tx, job.releaseId, 'attempt-b'));
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'dispatching' });
    await w.ledger.transact(tx => markUnknown(tx, job.releaseId, 'attempt-a'));
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'outcome_unknown' });
  });
});
