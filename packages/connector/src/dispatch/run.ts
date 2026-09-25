// The dispatcher. For each queued release it verifies the stored release and its exact payload,
// makes a scheduler claim in one ledger transaction, waits for the route's proved boundary, promotes
// the claim to a dispatch intent after revalidating the route, then submits it to the harness once
// and persists what the harness reported. It never retries a submission: a lost response becomes
// `outcome_unknown`.

import {
  type BindingId, type DeliveryReceipt, type HarnessCapabilities, type OwnerAuthority, type ReleaseId,
  type ReleasedJob, type UnverifiedReleasedJob, decodeHarnessCapabilities, validatePayloadBytes, verifyReleasedJob,
} from '@khala/contracts/delivery/index';
import { claim, precheck, promote, queuedRecord, requeue, sameRelease, wakeable } from './claim';
import { abandonUnknown, applyReceipt, decodeReceipt, markUnknown } from './reconcile';
import type {
  AttemptSnapshot, BlockCode, BoundaryObservation, DispatchDeps, Dispatcher, EnqueueResult, QuarantineCode,
} from './types';

type Verified = Readonly<{ ok: true; job: ReleasedJob }> | Readonly<{ ok: false; code: QuarantineCode }>;

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const { ledger, harness, boundary } = deps;
  const allowExperimentalAgentListener = deps.allowExperimentalAgentListener ?? false;
  let stopped = false;
  const lifetime = new AbortController();
  let pass: Promise<void> | null = null;
  let again = false;
  /** Boundary waits and submissions this instance is making. Their records are not reconciled from outside. */
  const inFlight = new Map<ReleaseId, Promise<void>>();

  const report = (error: unknown): void => deps.onError?.(error);

  async function verify(job: UnverifiedReleasedJob): Promise<Verified> {
    const approval = await deps.approvals.get(job.approval.commandId);
    if (approval === null) return { ok: false, code: 'approval_missing' };
    const verified = verifyReleasedJob(job, approval);
    if (!verified.ok) return { ok: false, code: verified.code === 'approval_mismatch' ? 'approval_mismatch' : 'release_invalid' };
    return { ok: true, job: verified.value };
  }

  async function quarantine(job: UnverifiedReleasedJob, code: QuarantineCode): Promise<void> {
    await ledger.transact(tx => {
      const record = tx.record(job.releaseId);
      if (record?.state === 'queued' && sameRelease(record.job, job)) tx.put({ ...record, state: 'quarantined', reason: code });
    });
  }

  /** Records why a queued job waits, without claiming it. */
  async function hold(job: UnverifiedReleasedJob, code: BlockCode): Promise<void> {
    await ledger.transact(tx => {
      const record = tx.record(job.releaseId);
      if (record?.state === 'queued' && sameRelease(record.job, job) && record.reason !== code) tx.put({ ...record, reason: code });
    });
  }

  async function inspect(job: ReleasedJob): Promise<HarnessCapabilities | null> {
    const decoded = decodeHarnessCapabilities(await harness.inspect(job.binding));
    return decoded.ok ? decoded.value : null;
  }

  function connectorUnknown(job: ReleasedJob): DeliveryReceipt {
    return {
      v: 1,
      receiptId: deps.newId('receipt') as DeliveryReceipt['receiptId'],
      releaseId: job.releaseId,
      bindingId: job.binding.bindingId,
      generation: job.binding.generation,
      kind: 'outcome_unknown',
      observedAt: deps.clock.now().toISOString(),
      source: 'connector',
      evidenceRef: null,
      errorCode: 'disconnected',
    };
  }

  async function submit(job: ReleasedJob, payload: Uint8Array, attemptId: string): Promise<void> {
    let receipt: DeliveryReceipt | null;
    try {
      receipt = decodeReceipt(await harness.submit({ job, payload }));
    } catch {
      receipt = connectorUnknown(job);
    }
    // A malformed receipt, or one naming another release, is evidence about nothing we sent.
    let stored = false;
    if (receipt?.releaseId === job.releaseId) {
      const evidence = receipt;
      try {
        stored = await ledger.transact(tx => applyReceipt(tx, evidence));
      } catch (error) {
        // The receipt is lost with its commit. What the harness did is now unknown.
        report(error);
      }
    }
    if (!stored) await ledger.transact(tx => markUnknown(tx, job.releaseId, attemptId));
    // A settled submission may have freed a slot or its binding.
    wake();
  }

  /**
   * Waits at the claimed route's proved boundary, then promotes and submits. Any exit before the
   * promotion commits, including stop, returns the claim to pending with its reservation kept. A
   * requeued release waits for a later wake rather than spinning on a boundary it just missed.
   */
  async function deliver(job: ReleasedJob, payload: Uint8Array, attemptId: string, snapshot: AttemptSnapshot): Promise<void> {
    let observation: BoundaryObservation | null = null;
    try {
      observation = await boundary.await({ job, snapshot, signal: lifetime.signal });
    } catch (error) {
      if (!stopped) report(error);
    }
    if (stopped || observation === null) {
      await ledger.transact(tx => requeue(tx, job.releaseId, 'boundary_unavailable', attemptId));
      return;
    }
    const decoded = decodeHarnessCapabilities(observation.capabilities);
    const { binding } = observation;
    let promoted;
    try {
      promoted = await ledger.transact(tx => promote(tx, {
        releaseId: job.releaseId,
        attemptId,
        binding,
        capabilities: decoded.ok ? decoded.value : null,
        payloadBytes: payload.byteLength,
        allowExperimentalAgentListener,
      }));
    } catch (error) {
      // Nothing was promoted, so nothing was sent. Leave no claim stranded on this binding.
      report(error);
      await ledger.transact(tx => requeue(tx, job.releaseId, 'boundary_unavailable', attemptId));
      return;
    }
    if (promoted.kind === 'dispatching') {
      // The intent is durable; the submission starts now and is never repeated.
      await submit(job, payload, attemptId);
    } else if (promoted.kind === 'rejected') {
      wake();
    }
  }

  /**
   * One queued release. Returns its binding when the release stays pending for a reason that must
   * also hold that binding's later releases in this pass, so they never overtake it.
   */
  async function attempt(releaseId: ReleaseId, held: ReadonlySet<BindingId>): Promise<BindingId | null> {
    // A job the controls hold now is not verified again until they change.
    const checked = await ledger.transact(tx => precheck(tx, releaseId, deps.clock.now(), held));
    if (checked.kind !== 'proceed') return checked.kind === 'held' ? checked.bindingId : null;
    const { record } = checked;
    const bindingId = record.job.binding.bindingId;

    const verified = await verify(record.job);
    if (!verified.ok) {
      await quarantine(record.job, verified.code);
      return null;
    }
    const { job } = verified;
    const capabilities = await inspect(job);
    if (capabilities === null) {
      await hold(job, 'harness_unsupported');
      return bindingId;
    }
    const stored = await deps.payloads.read(job.payloadRef, capabilities.limits.maxPayloadBytes);
    if (stored === null) {
      await quarantine(job, 'payload_missing');
      return null;
    }
    // Our own copy: the bytes checked against the digest are exactly the bytes submitted.
    const payload = stored.slice();
    if (!validatePayloadBytes(payload, capabilities.limits).ok) {
      await quarantine(job, 'payload_invalid');
      return null;
    }
    if (await deps.digest(payload) !== job.payloadDigest) {
      await quarantine(job, 'payload_digest_mismatch');
      return null;
    }
    if (stopped) return bindingId;

    const attemptId = deps.newId('attempt');
    const claimed = await ledger.transact(tx => claim(tx, {
      job, capabilities, now: deps.clock.now(), attemptId, workerId: deps.workerId, allowExperimentalAgentListener,
    }));
    if (claimed.kind !== 'claimed') {
      return claimed.code === 'budget_exhausted' || claimed.code === 'claimed_elsewhere' ? null : bindingId;
    }

    const delivery = deliver(job, payload, attemptId, claimed.snapshot)
      .catch(report)
      .finally(() => inFlight.delete(releaseId));
    inFlight.set(releaseId, delivery);
    return null;
  }

  async function drain(): Promise<void> {
    const queued = await ledger.transact(tx => tx.queued());
    const held = new Set<BindingId>();
    for (const releaseId of queued) {
      if (stopped) return;
      try {
        const binding = await attempt(releaseId, held);
        if (binding !== null) held.add(binding);
      } catch (error) {
        report(error);
      }
    }
  }

  function wake(): void {
    if (stopped) return;
    if (pass !== null) {
      again = true;
      return;
    }
    pass = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again && !stopped);
      } catch (error) {
        report(error);
      } finally {
        pass = null;
      }
    })();
  }

  async function idle(): Promise<void> {
    while (pass !== null || inFlight.size > 0) await Promise.allSettled([pass, ...inFlight.values()]);
  }

  async function enqueue(job: UnverifiedReleasedJob): Promise<EnqueueResult> {
    const result = await ledger.transact((tx): Readonly<{ result: EnqueueResult; wake: boolean }> => {
      const existing = tx.record(job.releaseId);
      if (existing !== null) return { result: sameRelease(existing.job, job) ? 'duplicate' : 'conflict', wake: false };
      // One approval releases once; a new release ID cannot re-send it under a fresh causal root.
      if (tx.releaseFor(job.approval.commandId) !== null) return { result: 'conflict', wake: false };
      tx.put(queuedRecord(job, tx.nextSeq()));
      // An `async` or paused arrival only persists: it wakes no pass and reaches no harness.
      return { result: 'queued', wake: wakeable(tx, job) };
    });
    if (result.wake) wake();
    return result.result;
  }

  async function observe(input: unknown): Promise<boolean> {
    const receipt = decodeReceipt(input);
    if (receipt === null) return false;
    const stored = await ledger.transact(tx => applyReceipt(tx, receipt));
    if (stored) wake();
    return stored;
  }

  async function reconcile(releaseId: string): Promise<void> {
    const id = releaseId as ReleaseId;
    if (inFlight.has(id)) return;
    const record = await ledger.transact(tx => tx.record(id));
    if (record === null) return;
    if (record.state === 'claimed') {
      // No boundary wait here holds it, and nothing was submitted: it is pending again.
      await ledger.transact(tx => requeue(tx, id, 'boundary_unavailable', record.attemptId));
      wake();
      return;
    }
    if (record.state !== 'dispatching' && record.state !== 'outcome_unknown') return;

    const verified = await verify(record.job);
    if (verified.ok) {
      let evidence: DeliveryReceipt | null = null;
      try {
        evidence = decodeReceipt(await harness.reconcile(verified.job));
      } catch (error) {
        report(error);
      }
      if (evidence?.releaseId === id) await ledger.transact(tx => applyReceipt(tx, evidence));
    }
    // Liveness of whoever claimed it is unknown, and so is acceptance. It is never re-queued.
    if (record.state === 'dispatching' && record.attemptId !== null) {
      const { attemptId } = record;
      await ledger.transact(tx => markUnknown(tx, id, attemptId));
    }
    wake();
  }

  async function abandon(authority: OwnerAuthority, releaseId: string): Promise<boolean> {
    const abandoned = await ledger.transact(tx => abandonUnknown(tx, authority, releaseId as ReleaseId));
    if (abandoned) wake();
    return abandoned;
  }

  async function stop(): Promise<void> {
    stopped = true;
    lifetime.abort();
    await idle();
  }

  return { enqueue, wake, idle, observe, reconcile, abandon, stop };
}
