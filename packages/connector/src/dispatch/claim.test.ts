import { describe, expect, it } from 'vitest';
import { binding, makeRelease, receipt, recordOf, seed, testPolicy, world } from './fakes';

describe('eligibility and transactional claim', () => {
  it('AE1: a pause applied before the claim blocks a queued job, and resuming dispatches it once', async () => {
    const w = await world(testPolicy({ paused: true }));
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    expect(await dispatcher.enqueue(job)).toBe('queued');
    await dispatcher.idle();

    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'paused', attemptId: null });
    expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);

    await w.ledger.transact(tx => tx.setPolicy(testPolicy()));
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted', reason: null });
  });

  it('AE1: a pause applied after the job was read but before the claim still blocks it', async () => {
    const w = await world();
    const release = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher({
      // Pause lands while the dispatcher is still verifying the payload, before the claim.
      payloads: {
        read: async () => {
          await w.ledger.transact(tx => tx.setPolicy(testPolicy({ paused: true })));
          return release.payload;
        },
      },
    });
    await dispatcher.enqueue(release.job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'paused' });
  });

  it('a pause applied after the claim does not recall the in-flight submission', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    w.harness.onSubmit = async submitted => {
      await w.ledger.transact(tx => tx.setPolicy(testPolicy({ paused: true })));
      return receipt(submitted, 'harness_queued');
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted' });
  });

  it('lets exactly one of two dispatchers on the same ledger claim a job', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await seed(w.ledger, job);
    const a = w.dispatcher({ workerId: 'worker-a' });
    const b = w.dispatcher({ workerId: 'worker-b' });
    a.wake();
    b.wake();
    await Promise.all([a.idle(), b.idle()]);
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(1);
  });

  it('rejects a release whose binding generation moved on', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await w.ledger.transact(tx => tx.setBinding({ binding: binding('bind-1', 1), revoked: false }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_binding' });
  });

  it('rejects a release whose binding is no longer known', async () => {
    const w = await world(testPolicy(), []);
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_binding' });
  });

  it('rejects a release reviewed under another policy version', async () => {
    const w = await world(testPolicy({ version: 4 }));
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_policy' });
  });

  it('stops new claims for a revoked binding', async () => {
    const w = await world();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await w.ledger.transact(tx => tx.setBinding({ binding: binding('bind-1'), revoked: true }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'revoked' });
  });

  it.each([
    ['no policy', null],
    ['an infinite causal limit', testPolicy({ maxJobsPerCausalRoot: Number.POSITIVE_INFINITY })],
    ['a zero concurrency limit', testPolicy({ maxConcurrentJobs: 0 })],
    ['a fractional limit', testPolicy({ maxJobsPerCausalRoot: 1.5 })],
    ['an unreadable expiry', testPolicy({ expiresAt: 'soon' })],
  ])('blocks dispatch with %s', async (_, policy) => {
    const w = await world(policy);
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'unconfigured' });
  });

  it('blocks claims once the policy has expired', async () => {
    const w = await world(testPolicy({ expiresAt: '2026-09-18T01:00:00Z' }));
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'expired' });
  });

  it('quarantines a release whose payload changed at the local handle', async () => {
    const w = await world();
    const release = w.add(makeRelease({ releaseId: 'release-1' }));
    release.payload.set([0x58], 0);
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(release.job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'quarantined', reason: 'payload_digest_mismatch' });
    expect(await w.ledger.transact(tx => tx.causalCount(release.job.causalRootId))).toBe(0);
  });

  it('quarantines a release without its approval or payload', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const orphan = makeRelease({ releaseId: 'release-orphan' });
    await dispatcher.enqueue(orphan.job);
    const noPayload = w.add(makeRelease({ releaseId: 'release-nopayload' }));
    await dispatcher.enqueue({ ...noPayload.job, payloadRef: 'ledger-missing' });
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-orphan')).toMatchObject({ state: 'quarantined', reason: 'approval_missing' });
    expect(await recordOf(w.ledger, 'release-nopayload')).toMatchObject({ state: 'quarantined', reason: 'payload_missing' });
  });

  it('quarantines a stored release that no longer matches its approval', async () => {
    const w = await world();
    const release = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue({ ...release.job, events: [{ ...release.job.events[0]!, eventId: 'event-other' as never }] });
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'quarantined', reason: 'release_invalid' });
  });

  it('treats a re-enqueued release as a duplicate and a changed one as a conflict', async () => {
    const w = await world(testPolicy({ paused: true }));
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    expect(await dispatcher.enqueue(job)).toBe('queued');
    expect(await dispatcher.enqueue(job)).toBe('duplicate');
    expect(await dispatcher.enqueue({ ...job, payloadDigest: `sha256:${'c'.repeat(64)}` })).toBe('conflict');
    await dispatcher.stop();
  });
});
