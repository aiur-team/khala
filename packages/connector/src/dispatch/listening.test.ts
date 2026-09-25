// Listening-mode dispatch: requested/effective gating, `modeAtClaim`, the proved boundary, drift
// back to pending, pause/wake and the dispatch-owned limits (E09 `listening-mode-dispatch`).

import { describe, expect, it, vi } from 'vitest';
import {
  type BindingId, type HarnessCapabilities, type SessionBinding, decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import { usablePolicy } from './budget';
import {
  EVIDENCE_REVISION, HARNESS_VERSION, type World, binding, capabilities, deferred, faultyLedger, listening, makeRelease,
  provenModes, receipt, recordOf, testLimits, testPolicy, world,
} from './fixtures/fakes';
import type { DispatchLedger, DispatchLimits, DispatchPolicy, DispatchTx } from './types';

const replacement = (generation = 1): SessionBinding => ({ ...binding('bind-1', generation), sessionId: 'thread-new' });

/** Sets the boundary to report `observed` capabilities for the claimed session. */
function boundaryReports(w: World, observed: HarnessCapabilities, session?: SessionBinding): void {
  w.boundary.onAwait = async ({ job }) => ({ binding: session ?? job.binding, capabilities: observed });
}

async function causalCount(w: World, root = 'cause-1'): Promise<number> {
  return w.ledger.transact(tx => tx.causalCount(root as Parameters<DispatchTx['causalCount']>[0]));
}

describe('requested and effective mode gating', () => {
  it('keeps async arrival silent', async () => {
    const w = await world(testPolicy({ listening: listening('async') }));
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));

    expect(await dispatcher.enqueue(job)).toBe('queued');
    await dispatcher.idle();
    // Arrival only persists: no pass, no harness inspection, notification, boundary or submit.
    expect(w.lookups).toEqual([]);
    expect(w.harness.inspected).toBe(0);
    expect(w.boundary.calls).toHaveLength(0);
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: null, reserved: false });

    // Even an explicit pass holds it before any harness call.
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.inspected).toBe(0);
    expect(w.boundary.calls).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'mode_async' });
    expect(await causalCount(w)).toBe(0);
  });

  it('AE2: an async release waits until the effective mode becomes sync and a wake delivers it once', async () => {
    const w = await world(testPolicy({ listening: listening('async') }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    await w.setPolicy(testPolicy({ listening: listening('sync', { version: 2 }) }));
    dispatcher.wake();
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      state: 'accepted', snapshot: { modeAtClaim: 'sync' },
    });
  });

  it.each([
    ['no effective mode', listening(null)],
    ['a requested mode the route does not yet support', listening('sync', { requested: 'steer' })],
    ['an effective mode that is not the requested one', listening('steer', { requested: 'sync' })],
  ])('holds %s without consuming budget or calling the harness', async (_, projection) => {
    const w = await world(testPolicy({ listening: projection }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.inspected).toBe(0);
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'mode_unavailable' });
    expect(await causalCount(w)).toBe(0);
  });

  it('delivers an effective steer release on the proved steer route', async () => {
    const w = await world(testPolicy({ listening: listening('steer') }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      snapshot: { modeAtClaim: 'steer', route: 'test-codex-interactive-steer' },
    });
  });

  it.each([
    ['capabilities that cannot be read', null],
    ['unknown support for the mode', { modes: provenModes({ sync: { status: 'unknown', reason: 'Not yet inspected.' } }) }],
    ['unsupported support for the mode', {
      modes: provenModes({ sync: { status: 'unsupported', reason: 'Proved negative.' } }),
    }],
    ['support blocked without a wrapper', {
      modes: provenModes({ sync: { status: 'blocked_without_wrapper', reason: 'Needs a wrapper.' } }),
    }],
    ['evidence other than the revision the effective mode was derived from', {
      modes: provenModes({ sync: { evidenceRevision: 'evidence-rev-2' } }),
    }],
  ] as const)('holds a release on %s without reserving', async (_, route) => {
    const w = await world();
    w.harness.route = route as Partial<HarnessCapabilities> | null;
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.boundary.calls).toHaveLength(0);
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'harness_unsupported' });
    expect(await causalCount(w)).toBe(0);
  });

  it('snapshots modeAtClaim and every route identity field at the scheduler claim', async () => {
    const w = await world();
    const gate = deferred<void>();
    const onAwait = w.boundary.onAwait;
    w.boundary.onAwait = async call => {
      await gate.promise;
      return onAwait(call);
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await until(() => w.boundary.calls.length === 1);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      state: 'claimed',
      reserved: true,
      snapshot: {
        modeAtClaim: 'sync',
        bindingGeneration: 0,
        sessionId: 'thread-bind-1',
        harness: 'codex',
        harnessVersion: HARNESS_VERSION,
        adapterVersion: 'test-adapter',
        route: 'test-codex-interactive-sync',
        evidenceRevision: EVIDENCE_REVISION,
      },
    });
    expect(w.boundary.calls[0]!.snapshot).toMatchObject({ modeAtClaim: 'sync' });
    expect(w.harness.submitted).toHaveLength(0);
    gate.resolve();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
  });
});

describe('the proved boundary', () => {
  it('does not deliver a claimed release to a replacement session', async () => {
    const w = await world();
    // The boundary is about to deliver into a replacement session of the same binding.
    w.boundary.onAwait = async () => ({ binding: replacement(), capabilities: capabilities() });
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();

    expect(w.boundary.calls).toHaveLength(1);
    expect(w.harness.submitted).toHaveLength(0);
    const record = await recordOf(w.ledger, 'release-1');
    expect(record).toMatchObject({
      state: 'queued', reason: 'route_drift', attemptId: null, snapshot: null, reserved: true, receipts: [],
    });
    expect(await causalCount(w)).toBe(1);
  });

  it('does not deliver a claimed release after the durable binding is replaced (AE1)', async () => {
    const w = await world();
    // The binding is replaced while the attempt waits; the boundary still reports the old session.
    w.boundary.onAwait = async ({ job }) => {
      await w.ledger.transact(tx => tx.setBinding({ binding: replacement(), revoked: false }));
      return { binding: job.binding, capabilities: capabilities() };
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'route_drift', receipts: [] });

    // Pending again, it is then judged against the replacement and never reaches it.
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'stale_binding' });
  });

  const nextVersion = '0.155.0';
  it.each([
    ['route', capabilities('queue', { modes: provenModes({ sync: { route: 'test-codex-other-sync' } }) })],
    ['harness version', capabilities('queue', {
      version: nextVersion,
      modes: provenModes({
        steer: { testedVersion: nextVersion }, sync: { testedVersion: nextVersion }, async: { testedVersion: nextVersion },
      }),
    })],
    ['adapter version', capabilities('queue', { adapterVersion: 'test-adapter-2' })],
    ['evidence revision', capabilities('queue', { modes: provenModes({ sync: { evidenceRevision: 'evidence-rev-2' } }) })],
    ['mode support', capabilities('queue', { modes: provenModes({ sync: { status: 'unknown', reason: 'Version drift.' } }) })],
  ])('returns a claimed release to pending when its %s drifts before delivery', async (_, observed) => {
    const w = await world();
    boundaryReports(w, observed);
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      state: 'queued', reason: 'route_drift', reserved: true, receipts: [],
    });
  });

  it('records a binding revoked while the attempt waited as revoked, with no submission', async () => {
    const w = await world();
    w.boundary.onAwait = async ({ job }) => {
      await w.ledger.transact(tx => tx.setBinding({ binding: binding('bind-1'), revoked: true }));
      return { binding: job.binding, capabilities: capabilities() };
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'rejected', reason: 'revoked', receipts: [] });
  });

  it.each([
    ['a pause', testPolicy({ version: 4, armedAt: 3, paused: true })],
    ['a mode change to async', testPolicy({ listening: listening('async', { version: 2 }) })],
  ])('AE3: %s after the claim neither cancels the attempt nor rewrites modeAtClaim', async (_, next) => {
    const w = await world();
    w.boundary.onAwait = async ({ job }) => {
      await w.setPolicy(next);
      return { binding: job.binding, capabilities: capabilities() };
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'accepted', snapshot: { modeAtClaim: 'sync' } });
  });

  it.each([
    ['is not observed', async () => null],
    ['fails', async () => { throw new Error('boundary lost'); }],
  ])('keeps the one reservation when the boundary %s, and a later wake delivers once', async (_, behavior) => {
    const w = await world();
    const reached = w.boundary.onAwait;
    w.boundary.onAwait = behavior;
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      state: 'queued', reason: 'boundary_unavailable', reserved: true,
    });
    expect(await causalCount(w)).toBe(1);

    w.boundary.onAwait = reached;
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await causalCount(w)).toBe(1);
  });

  it('returns the claim to pending when the promotion commit fails, without submitting', async () => {
    const w = await world();
    const ledger = faultyLedger(w.ledger);
    // Enqueue, queue read, precheck, scheduler claim, then the promotion.
    ledger.crashAt(5, 'before');
    const dispatcher = w.dispatcher({ ledger });
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.idle();
    expect(w.errors).toHaveLength(1);
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      state: 'queued', reason: 'boundary_unavailable', reserved: true,
    });
  });

  it('stop aborts a boundary wait and returns the claim to pending without submitting', async () => {
    const w = await world();
    const aborted = deferred<void>();
    w.boundary.onAwait = ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted.resolve();
        reject(new Error('aborted'));
      });
    });
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await until(() => w.boundary.calls.length === 1);
    await dispatcher.stop();
    await aborted.promise;
    expect(w.harness.submitted).toHaveLength(0);
    expect(w.errors).toEqual([]);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({
      state: 'queued', reason: 'boundary_unavailable', reserved: true,
    });
  });

  it('a claim waiting at its boundary is not reconciled from outside and receives no receipt', async () => {
    const w = await world();
    const gate = deferred<void>();
    const reached = w.boundary.onAwait;
    w.boundary.onAwait = async call => {
      await gate.promise;
      return reached(call);
    };
    const dispatcher = w.dispatcher();
    const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
    await dispatcher.enqueue(job);
    await until(() => w.boundary.calls.length === 1);
    await dispatcher.reconcile('release-1');
    expect(await dispatcher.observe(receipt(job, 'harness_queued'))).toBe(false);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'claimed', receipts: [] });
    gate.resolve();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
  });
});

describe('ordered boundary limits', () => {
  it('AE5: delivers a payload exactly at the boundary byte limit', async () => {
    const w = await world();
    const release = w.add(makeRelease({ releaseId: 'release-1' }));
    boundaryReports(w, capabilities('queue', { limits: limits(1, release.payload.byteLength) }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(release.job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
  });

  it('AE5: holds a release one byte over the boundary limit, and its binding suffix behind it', async () => {
    const w = await world();
    const first = w.add(makeRelease({ releaseId: 'release-1' }));
    const second = w.add(makeRelease({ releaseId: 'release-2' }));
    const other = w.add(makeRelease({ releaseId: 'release-3', bindingId: 'bind-2' }));
    w.boundary.onAwait = async ({ job }) => ({
      binding: job.binding,
      capabilities: capabilities('queue', job.releaseId === 'release-1'
        ? { limits: limits(50, first.payload.byteLength - 1) }
        : {}),
    });
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(first.job);
    await dispatcher.enqueue(second.job);
    await dispatcher.enqueue(other.job);
    await dispatcher.idle();

    // The oversized release is not split or skipped; the release after it on the same binding waits.
    expect(w.harness.submittedIds()).toEqual(['release-3']);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'boundary_limit' });
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reserved: false });
    // Each later wake retries the oversized release, which still holds its one reservation; the
    // release behind it never reaches the boundary.
    expect(w.boundary.calls.map(call => call.job.releaseId)).not.toContain('release-2');
    expect(await causalCount(w)).toBe(2);
    // The harness byte read stays bounded by the claim-time limit plus one.
    expect(w.reads.every(read => read.maxBytes === capabilities().limits.maxPayloadBytes)).toBe(true);
  });

  it('keeps a later release on the same binding behind a claim still waiting at its boundary', async () => {
    const w = await world();
    const gate = deferred<void>();
    const reached = w.boundary.onAwait;
    w.boundary.onAwait = async call => {
      if (call.job.releaseId === 'release-1') await gate.promise;
      return reached(call);
    };
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2' })).job);
    await until(() => w.boundary.calls.length === 1);
    let waiting = await recordOf(w.ledger, 'release-2');
    for (let i = 0; i < 1000 && waiting?.reason !== 'busy'; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
      waiting = await recordOf(w.ledger, 'release-2');
    }
    // Even under a `queue` busy policy on a queueing route, it does not overtake the first claim.
    expect(waiting).toMatchObject({ state: 'queued', reason: 'busy' });
    expect(w.boundary.calls).toHaveLength(1);
    gate.resolve();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
  });
});

describe('dispatch-owned local limits and pause/wake', () => {
  it('rejects maxCausalDepth in the dispatch policy', async () => {
    const withDepth = { ...testPolicy(), maxCausalDepth: 3 } as unknown as DispatchPolicy;
    expect(usablePolicy(testPolicy())).toBe(true);
    expect(usablePolicy(withDepth)).toBe(false);

    const w = await world(withDepth);
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.inspected).toBe(0);
    expect(w.harness.submitted).toHaveLength(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'unconfigured' });
  });

  it('resume does not reset causal counters', async () => {
    const w = await world(testPolicy(), undefined, testLimits({ maxJobsPerCausalRoot: 1 }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', root: 'cause-a' })).job);
    await dispatcher.idle();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', root: 'cause-a' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'budget_exhausted' });

    // Pause at v4 and resume at v5, waking repeatedly: the exhausted root stays held.
    await w.setPolicy(testPolicy({ version: 4, armedAt: 3, paused: true }));
    dispatcher.wake();
    await dispatcher.idle();
    await w.setPolicy(testPolicy({ version: 5, armedAt: 3 }));
    dispatcher.wake();
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await causalCount(w, 'cause-a')).toBe(1);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'budget_exhausted' });

    // AE4: a human-authored message starts a new causal root, independently eligible.
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-3', root: 'cause-b' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1', 'release-3']);
  });

  it('coalesces arrival and resume wakes into at most one further pass', async () => {
    const w = await world();
    const passes = { count: 0 };
    const gate = deferred<void>();
    let first = true;
    w.onApproval = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    };
    // Submissions stay open, so no settled submission wakes a pass of its own.
    const settle = deferred<void>();
    w.harness.onSubmit = async job => {
      await settle.promise;
      return receipt(job, 'harness_queued');
    };
    const dispatcher = w.dispatcher({ ledger: countingPasses(w.ledger, passes) });
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await until(() => w.lookups.length === 1);
    for (let i = 0; i < 5; i += 1) dispatcher.wake();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' })).job);
    gate.resolve();
    await until(() => w.harness.submitted.length === 2);
    // Six wakes during the first pass became exactly one further pass.
    expect(passes.count).toBe(2);
    settle.resolve();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1', 'release-2']);
    expect(await causalCount(w)).toBe(2);
  });

  it('pause holds every mode before any harness call, and a later resume wake claims once', async () => {
    const w = await world(testPolicy({ version: 4, armedAt: 3, paused: true, listening: listening('steer') }));
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.inspected).toBe(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'paused' });

    await w.setPolicy(testPolicy({ version: 5, armedAt: 3, listening: listening('steer') }));
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await causalCount(w)).toBe(1);
  });
});

describe('injected local limits', () => {
  /** The approved local profile's dispatch share, as composition injects it. */
  const PROFILE = { maxJobsPerCausalRoot: 3, maxConcurrentJobs: 1, busy: 'wait' } as const;

  it('a policy carrying looser limits cannot loosen the injected profile', async () => {
    const loosening = { ...testPolicy(), maxConcurrentJobs: 10, busy: 'queue' } as unknown as DispatchPolicy;
    expect(usablePolicy(loosening)).toBe(false);
    const w = await world(loosening, ['bind-1', 'bind-2'], PROFILE);
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1' })).job);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' })).job);
    dispatcher.wake();
    await dispatcher.idle();
    // The policy's limits are never adopted: it is unusable, so nothing reaches the harness.
    expect(w.harness.inspected).toBe(0);
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'unconfigured' });

    // With a limit-free policy, the injected `maxConcurrentJobs: 1` holds the second binding.
    await w.setPolicy(testPolicy());
    dispatcher.wake();
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'at_capacity' });
  });

  it('under the injected `wait` a later release on a busy binding waits, never queues behind it', async () => {
    const w = await world(testPolicy(), ['bind-1'], { ...PROFILE, maxConcurrentJobs: 2 });
    const dispatcher = w.dispatcher();
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2' })).job);
    await dispatcher.idle();
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'busy' });
  });

  it.each([
    ['a maxCausalDepth', { ...PROFILE, maxCausalDepth: 3 }],
    ['an infinite causal limit', { ...PROFILE, maxJobsPerCausalRoot: Number.POSITIVE_INFINITY }],
    ['a zero concurrency limit', { ...PROFILE, maxConcurrentJobs: 0 }],
    ['a fractional limit', { ...PROFILE, maxJobsPerCausalRoot: 1.5 }],
    ['a steer busy policy', { ...PROFILE, busy: 'steer' }],
    ['no busy policy', { maxJobsPerCausalRoot: 3, maxConcurrentJobs: 1 }],
  ])('refuses to construct with %s', async (_, limits) => {
    const w = await world(testPolicy(), ['bind-1'], limits as unknown as DispatchLimits);
    expect(() => w.dispatcher()).toThrow(RangeError);
  });
});

describe('retry wake after a pre-effect return to pending', () => {
  it('retries a release returned from an unavailable boundary without any other wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = await world();
      let misses = 1;
      const reached = w.boundary.onAwait;
      w.boundary.onAwait = async call => (misses-- > 0 ? null : reached(call));
      const dispatcher = w.dispatcher({ retryDelayMs: 100 });
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      await dispatcher.idle();
      expect(w.harness.submitted).toHaveLength(0);
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'boundary_unavailable' });

      await vi.advanceTimersByTimeAsync(100);
      await dispatcher.idle();
      expect(w.harness.submittedIds()).toEqual(['release-1']);
      expect(await causalCount(w)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries route drift and backs off while the boundary stays unavailable, and stop cancels it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = await world();
      boundaryReports(w, capabilities('queue', { version: '0.155.0' }));
      const dispatcher = w.dispatcher({ retryDelayMs: 100 });
      await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1' })).job);
      await dispatcher.idle();
      expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'queued', reason: 'route_drift' });
      expect(w.boundary.calls).toHaveLength(1);

      // Delays of 100, 200 and 400 ms: three retries in 700 ms, none sooner.
      await vi.advanceTimersByTimeAsync(99);
      expect(w.boundary.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(601);
      await dispatcher.idle();
      expect(w.boundary.calls).toHaveLength(4);
      expect(w.harness.submitted).toHaveLength(0);
      expect(await causalCount(w)).toBe(1);

      await dispatcher.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(w.boundary.calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('receipt-derived decisions', () => {
  it('advances only on retained correlated receipt kinds and has no delivered fact', async () => {
    const w = await world();
    const dispatcher = w.dispatcher();
    const refused = w.add(makeRelease({ releaseId: 'release-1' }));
    w.harness.onSubmit = async job => receipt(job, 'failed', { errorCode: 'harness_rejected' });
    await dispatcher.enqueue(refused.job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-1')).toMatchObject({ state: 'failed' });

    const unknown = w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' }));
    w.harness.onSubmit = async job => receipt(job, 'failed', { errorCode: 'timeout' });
    await dispatcher.enqueue(unknown.job);
    await dispatcher.idle();
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'outcome_unknown' });

    // There is no generic `delivered` receipt kind to record.
    expect(await dispatcher.observe({ ...receipt(unknown.job, 'harness_queued'), kind: 'delivered' })).toBe(false);
    // Evidence for another binding's session moves nothing.
    expect(await dispatcher.observe(receipt(unknown.job, 'harness_queued', {
      bindingId: 'bind-3' as BindingId,
    }))).toBe(false);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'outcome_unknown' });
    expect(await dispatcher.observe(receipt(unknown.job, 'harness_queued'))).toBe(true);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'accepted' });
  });
});

function limits(maxSelectionEvents: number, maxPayloadBytes: number): HarnessCapabilities['limits'] {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents, maxPayloadBytes });
  if (!decoded.ok) throw new Error('fixture limits rejected');
  return decoded.value;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) await new Promise(resolve => setImmediate(resolve));
  if (!condition()) throw new Error('condition not reached');
}

/** Counts dispatcher passes: each pass begins with a transaction that only reads the queue. */
function countingPasses(inner: DispatchLedger, passes: { count: number }): DispatchLedger {
  return {
    transact: work => inner.transact(tx => {
      const calls: string[] = [];
      const traced = Object.fromEntries(Object.entries(bind(tx)).map(([name, method]) => [
        name,
        (...args: unknown[]) => {
          calls.push(name);
          return (method as (...values: unknown[]) => unknown)(...args);
        },
      ])) as unknown as DispatchTx;
      const result = work(traced);
      if (calls.length === 1 && calls[0] === 'queued') passes.count += 1;
      return result;
    }),
  };
}

function bind(tx: DispatchTx): DispatchTx {
  return {
    policy: id => tx.policy(id),
    binding: id => tx.binding(id),
    record: id => tx.record(id),
    releaseFor: id => tx.releaseFor(id),
    put: record => tx.put(record),
    queued: () => tx.queued(),
    active: () => tx.active(),
    nextSeq: () => tx.nextSeq(),
    causalCount: root => tx.causalCount(root),
    setCausalCount: (root, count) => tx.setCausalCount(root, count),
  };
}
