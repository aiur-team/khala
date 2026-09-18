// The dispatcher. For each queued release it verifies the stored release and its exact payload,
// claims it in one ledger transaction, then submits it to the harness once and persists what the
// harness reported. It never retries a submission: a lost response becomes `outcome_unknown`.

import {
  type DeliveryReceipt, type ReleaseId, type ReleasedJob, type UnverifiedReleasedJob, validatePayloadBytes,
  verifyReleasedJob,
} from '@khala/contracts/delivery/index';
import { claim, queuedRecord, sameRelease } from './claim';
import { abandonUnknown, applyReceipt, markUnknown } from './reconcile';
import type { DispatchDeps, Dispatcher, EnqueueResult, QuarantineCode } from './types';

type Verified = Readonly<{ ok: true; job: ReleasedJob }> | Readonly<{ ok: false; code: QuarantineCode }>;

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const { ledger, harness } = deps;
  let stopped = false;
  let pass: Promise<void> | null = null;
  let again = false;
  /** Submissions this instance is making. Their records are not reconciled from outside. */
  const submitting = new Map<ReleaseId, Promise<void>>();

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
    let receipt: DeliveryReceipt;
    try {
      receipt = await harness.submit({ job, payload });
    } catch {
      receipt = connectorUnknown(job);
    }
    // A receipt naming another release is evidence about nothing we sent.
    const stored = receipt.releaseId === job.releaseId && await ledger.transact(tx => applyReceipt(tx, receipt));
    if (!stored) await ledger.transact(tx => markUnknown(tx, job.releaseId, attemptId));
    // A settled submission may have freed a slot or its binding.
    wake();
  }

  async function attempt(releaseId: ReleaseId): Promise<void> {
    const record = await ledger.transact(tx => tx.record(releaseId));
    if (record?.state !== 'queued') return;

    const verified = await verify(record.job);
    if (!verified.ok) return quarantine(record.job, verified.code);
    const { job } = verified;
    const stored = await deps.payloads.read(job.payloadRef);
    if (stored === null) return quarantine(job, 'payload_missing');
    // Our own copy: the bytes checked against the digest are exactly the bytes submitted.
    const payload = stored.slice();
    const capabilities = await harness.inspect(job.binding);
    if (!validatePayloadBytes(payload, capabilities.limits).ok) return quarantine(job, 'payload_invalid');
    if (await deps.digest(payload) !== job.payloadDigest) return quarantine(job, 'payload_digest_mismatch');

    const attemptId = deps.newId('attempt');
    const now = deps.clock.now();
    const claimed = await ledger.transact(tx => claim(tx, {
      job, harnessBusy: capabilities.busy, now, attemptId, workerId: deps.workerId,
    }));
    if (claimed.kind !== 'claimed') return;

    // The intent is durable; the submission starts now and is never repeated.
    const submission = submit(job, payload, attemptId).catch(report).finally(() => submitting.delete(releaseId));
    submitting.set(releaseId, submission);
  }

  async function drain(): Promise<void> {
    const queued = await ledger.transact(tx => tx.queued());
    for (const releaseId of queued) {
      if (stopped) return;
      try {
        await attempt(releaseId);
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
    while (pass !== null || submitting.size > 0) await Promise.allSettled([pass, ...submitting.values()]);
  }

  async function enqueue(job: UnverifiedReleasedJob): Promise<EnqueueResult> {
    const result = await ledger.transact((tx): EnqueueResult => {
      const existing = tx.record(job.releaseId);
      if (existing !== null) return sameRelease(existing.job, job) ? 'duplicate' : 'conflict';
      // One approval releases once; a new release ID cannot re-send it under a fresh causal root.
      if (tx.releaseFor(job.approval.commandId) !== null) return 'conflict';
      tx.put(queuedRecord(job, tx.nextSeq()));
      return 'queued';
    });
    if (result === 'queued') wake();
    return result;
  }

  async function observe(receipt: DeliveryReceipt): Promise<boolean> {
    const stored = await ledger.transact(tx => applyReceipt(tx, receipt));
    if (stored) wake();
    return stored;
  }

  async function reconcile(releaseId: string): Promise<void> {
    const id = releaseId as ReleaseId;
    if (submitting.has(id)) return;
    const record = await ledger.transact(tx => tx.record(id));
    if (record === null || (record.state !== 'dispatching' && record.state !== 'outcome_unknown')) return;

    const verified = await verify(record.job);
    if (verified.ok) {
      let evidence: DeliveryReceipt | null = null;
      try {
        evidence = await harness.reconcile(verified.job);
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

  async function abandon(releaseId: string): Promise<boolean> {
    const abandoned = await ledger.transact(tx => abandonUnknown(tx, releaseId as ReleaseId));
    if (abandoned) wake();
    return abandoned;
  }

  async function stop(): Promise<void> {
    stopped = true;
    await idle();
  }

  return { enqueue, wake, idle, observe, reconcile, abandon, stop };
}
