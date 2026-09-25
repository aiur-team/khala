import { describe, expect, it } from 'vitest';
import type { BindingId, HarnessCapabilities } from '@khala/contracts/delivery/index';
import { type World, binding, makeRelease, receipt, recordOf, seed, testPolicy, world } from './fixtures/fakes';
import type { DispatchPolicy, Dispatcher } from './types';

describe('eligibility and transactional claim', () => {
  it('AE1: a pause applied before the claim blocks a queued job, and resuming dispatches it once', async () => {
    // Released at v3. As in KHA-120's transitions, the pause (v4) and the resume (v5) each bump the
    // version; neither re-arms the binding.
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1', policyVersion: 3 }));
    await w.setPolicy(testPolicy({ version: 4, armedAt: 3, paused: true }));
    expect(await dispatcher.enqueue(job)).toBe('queued');
    await dispatcher.idle();
    // A paused arrival only persists; it starts no pass.
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: null });
    dispatcher.wake();
    await dispatcher.idle();

    expect(w.harness.submitted).toHaveLength(0);
    expect(w.boundary.calls).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'paused', attemptId: null });
    expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);

    await w.setPolicy(testPolicy({ version: 5, armedAt: 3 }));
    dispatcher.wake();
    await dispatcher.idle();
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted', reason: null });
  });

  it('rejects a paused release when the binding is re-armed before the resume', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1', policyVersion: 3 }));
    await w.setPolicy(testPolicy({ version: 4, armedAt: 3, paused: true }));
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    // v5 re-arms while paused; v6 resumes.
    await w.setPolicy(testPolicy({ version: 6, armedAt: 5 }));
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_policy' });
  });

  it('AE1: a pause applied after the job was read but before the claim still blocks it', async () => {
    const w = await world();
    const release = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher({
      // Pause lands while the dispatcher is still verifying the payload, before the claim.
      payloads: {
        read: async () => {
          await w.setPolicy(testPolicy({ version: 4, armedAt: 3, paused: true }));
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
      await w.setPolicy(testPolicy({ version: 4, armedAt: 3, paused: true }));
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
    // With no policy the arrival does not wake; a later pass finds the binding gone.
    dispatcher.wake();
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_binding' });
  });

  it.each([
    ['before the binding was re-armed', 3, testPolicy({ version: 4, armedAt: 4 })],
    ['under a version the connector has not applied', 4, testPolicy({ version: 3, armedAt: 3 })],
  ])('rejects a release reviewed %s', async (_, policyVersion, policy) => {
    const w = await world(policy);
    const { job } = w.add(makeRelease({ releaseId: 'release-1', policyVersion }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_policy' });
  });

  it('dispatches a release reviewed exactly at the arming version, after later non-arming revisions', async () => {
    const w = await world(testPolicy({ version: 7, armedAt: 3 }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', policyVersion: 3 })).job);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', policyVersion: 7 })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
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
    ['an expiry with an offset', testPolicy({ expiresAt: '2026-09-18T03:00:00+02:00' })],
    ['an expiry on a date that does not exist', testPolicy({ expiresAt: '2026-02-30T00:00:00Z' })],
    ['no pause flag', malformed(policy => delete policy.paused)],
    ['an undefined pause flag', malformed(policy => { policy.paused = undefined; })],
    ['a string pause flag', malformed(policy => { policy.paused = 'false'; })],
    ['no expiry field', malformed(policy => delete policy.expiresAt)],
    ['an unknown field', malformed(policy => { policy.resetBy = 'agent'; })],
    ['a steer busy policy', malformed(policy => { policy.busy = 'steer'; })],
    ['a negative version', testPolicy({ version: -1 })],
    ['a fractional version', testPolicy({ version: 3.5 })],
    ['an arming version after the version', testPolicy({ version: 3, armedAt: 4 })],
    ['a negative arming version', testPolicy({ armedAt: -1 })],
    ['a fractional arming version', testPolicy({ armedAt: 2.5 })],
    ['no arming version', malformed(policy => delete policy.armedAt)],
  ])('blocks dispatch with %s', async (_, policy) => {
    const w = await world(policy);
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(job);
    dispatcher.wake();
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

  describe('policy per binding', () => {
    it("checks each release against its own binding's policy version", async () => {
      const w = await world();
      await w.ledger.transact(tx => tx.setPolicy('bind-2' as BindingId, testPolicy({ version: 4, armedAt: 4 })));
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1', policyVersion: 3 })).job);
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', policyVersion: 4 })).job);
      await dispatcher.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
    });

    it('rejects a release reviewed before its own binding was re-armed, while other bindings are unchanged', async () => {
      const w = await world();
      const dispatcher = w.dispatcher();
      const { job } = w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-2', policyVersion: 3 }));
      // bind-2 re-arms from v3 to v4; bind-1 and bind-3 stay at v3.
      await w.ledger.transact(tx => tx.setPolicy('bind-2' as BindingId, testPolicy({ version: 4, armedAt: 4 })));
      await dispatcher.enqueue(job);
      await dispatcher.idle();
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_policy' });
    });

    it('applies a pause to its own binding only', async () => {
      const w = await world();
      await w.ledger.transact(tx => tx.setPolicy('bind-1' as BindingId, testPolicy({ paused: true })));
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1' })).job);
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' })).job);
      await dispatcher.idle();
      expect(w.harness.submittedIds()).toEqual(['release-2']);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'paused' });
    });
  });

  describe('harness route', () => {
    it('submits through a tested native CLI queue route with evidence', async () => {
      const w = await world();
      w.harness.route = { existingSession: 'native_cli_queue', immediateNotification: 'native_cli_queue' };
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      await dispatcher.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
    });

    it('submits through the experimental agent listener only with an explicit opt-in', async () => {
      const w = await world();
      w.harness.route = {
        support: 'experimental',
        existingSession: 'agent_installed_listener',
        immediateNotification: 'agent_installed_listener',
        busy: 'unknown',
        evidenceRef: null,
      };
      const dispatcher = w.dispatcher({ allowExperimentalAgentListener: true });
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      await dispatcher.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
    });

    it('refuses the experimental agent listener without the opt-in', async () => {
      const w = await world();
      w.harness.route = {
        support: 'experimental',
        existingSession: 'agent_installed_listener',
        immediateNotification: 'agent_installed_listener',
        busy: 'unknown',
        evidenceRef: null,
      };
      const dispatcher = w.dispatcher();
      const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
      await dispatcher.enqueue(job);
      await dispatcher.idle();
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'harness_unsupported' });
      expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);
    });

    it.each([
      ['a route that steers a running turn', { busy: 'steer' }],
      ['a route with unknown busy behavior', { busy: 'unknown' }],
      ['an unsupported route', { support: 'unsupported' }],
      ['an experimental native route', { support: 'experimental' }],
      ['a route that cannot resume the existing session', { existingSession: 'unknown' }],
      ['a route without immediate notification', { immediateNotification: 'unknown' }],
      ['a route for another harness', { harness: 'claude' }],
      ['a malformed capability report', null],
      ['a tested route with no evidence, which the decoder rejects', { evidenceRef: null }],
    ] as Array<[string, Partial<HarnessCapabilities> | null]>)('refuses %s before claiming, even with the session idle', async (_, route) => {
      const w = await world();
      w.harness.route = route;
      const dispatcher = w.dispatcher();
      const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
      await dispatcher.enqueue(job);
      await dispatcher.idle();
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'harness_unsupported', attemptId: null });
      expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);
    });

    it('submits to an idle session on a route that rejects when busy', async () => {
      const w = await world();
      w.harness.busy = 'reject';
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      await dispatcher.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
    });
  });

  describe('claim guards', () => {
    it('does not claim when the stored release changed after it was verified', async () => {
      const w = await world();
      const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
      await seed(w.ledger, job);
      // Another writer replaces the stored release while this one is being verified.
      w.onApproval = () => w.ledger.transact(tx => {
        const record = tx.record(job.releaseId)!;
        tx.put({ ...record, job: { ...record.job, causalRootId: 'cause-other' as never } });
      });
      const dispatcher = w.dispatcher();
      dispatcher.wake();
      await dispatcher.idle();
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', attemptId: null });
      expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);
    });

    it.each([
      ['revoked', 'revoked', (w: World) => w.ledger.transact(tx => tx.setBinding({ binding: binding('bind-1'), revoked: true }))],
      ['moved to a new generation', 'stale_binding', (w: World) => w.ledger.transact(tx => tx.setBinding({ binding: binding('bind-1', 1), revoked: false }))],
      ['re-armed', 'stale_policy', (w: World) => w.setPolicy(testPolicy({ version: 4, armedAt: 4 }))],
    ])('rejects at the claim a job whose binding was %s after the precheck', async (_, code, change) => {
      const w = await world();
      const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
      // The change lands while the job is being verified, after the precheck passed it.
      w.onApproval = () => change(w);
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(job);
      await dispatcher.idle();
      expect(w.lookups).toEqual([job.approval.commandId]);
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: code, attemptId: null });
      expect(await w.ledger.transact(tx => tx.causalCount(job.causalRootId))).toBe(0);
    });

    it('skips a listed release that another worker claimed before this pass reached it', async () => {
      const w = await world();
      const one = w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1', root: 'cause-1' })).job;
      const two = w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', root: 'cause-2' })).job;
      await seed(w.ledger, one);
      await seed(w.ledger, two);
      w.onApproval = id => {
        if (id !== one.approval.commandId) return;
        return w.ledger.transact(tx => {
          tx.put({ ...tx.record(two.releaseId)!, state: 'dispatching', attemptId: 'attempt-other', workerId: 'worker-other' });
        });
      };
      const dispatcher = w.dispatcher();
      dispatcher.wake();
      await dispatcher.idle();
      expect(w.lookups).toEqual([one.approval.commandId]);
      expect(w.harness.submittedIds()).toEqual(['release-1']);
    });

    it('does not verify a job that the controls hold, however often it is woken', async () => {
      const w = await world(testPolicy({ paused: true }));
      const dispatcher = w.dispatcher();
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      for (let i = 0; i < 3; i += 1) {
        dispatcher.wake();
        await dispatcher.idle();
      }
      expect(w.lookups).toEqual([]);
      expect(w.reads).toEqual([]);
      expect(w.harness.inspected).toBe(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'paused' });
    });

    it('makes no new claim and starts no new attempt once stopped', async () => {
      const w = await world();
      const one = w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1', root: 'cause-1' })).job;
      await seed(w.ledger, one);
      await seed(w.ledger, w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2', root: 'cause-2' })).job);
      let dispatcher: Dispatcher | null = null;
      let stopped: Promise<void> | null = null;
      w.onApproval = () => { stopped ??= dispatcher!.stop(); };
      dispatcher = w.dispatcher();
      dispatcher.wake();
      await dispatcher.idle();
      await stopped;
      expect(w.harness.submitted).toHaveLength(0);
      expect(w.lookups).toEqual([one.approval.commandId]);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', attemptId: null });
    });
  });
});

/** A fixture policy edited into a shape the type system would refuse. */
function malformed(edit: (policy: Record<string, unknown>) => unknown): DispatchPolicy {
  const policy: Record<string, unknown> = { ...testPolicy() };
  edit(policy);
  return policy as DispatchPolicy;
}
