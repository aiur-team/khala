// Codex harness adapter (KHA-118) for the one route KHA-104 proved: a thread hosted
// by a Khala-started `codex app-server`, delivered through `thread/queue/add`.
// KHA-133 composes the native client, host registry and stores.

import type {
  DeliveryLimits, DeliveryReceipt, HarnessCapabilities, HarnessPort, ReleasedJob, ReleaseId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { probeBinding, testedCapabilities, unsupportedCapabilities } from './capabilities';
import { type CodexClientPort, type CodexDeadlines, type CodexHostPort, withDeadline } from './native';
import { reconcileRelease } from './reconcile';
import { type Clock, type EvidenceSink, makeReceipt } from './receipts';
import { type AttemptedReleases, type ReleaseCodecPort, submitRelease } from './transport';

export {
  CODEX_ADAPTER_VERSION, CODEX_EVIDENCE_REF, CODEX_HARNESS, CODEX_RECEIPT_EVIDENCE, TESTED_CODEX_VERSIONS,
  type ProbeFailure, probeBinding,
} from './capabilities';
export type {
  CodexClientPort, CodexConnection, CodexDeadlines, CodexEndpoint, CodexHost, CodexHostPort, CodexMethod,
  CodexRequestOutcome,
} from './native';
export {
  type Clock, type CodexReceiptTracker, type EvidenceSink, type NativeNotification, createCodexReceiptTracker,
  receiptIdFor,
} from './receipts';
export type { ReleaseCodecPort } from './transport';

export type CodexHarnessDeps = Readonly<{
  client: CodexClientPort;
  hosts: CodexHostPort;
  codec: ReleaseCodecPort;
  clock: Clock;
  evidence: EvidenceSink;
  limits: DeliveryLimits;
  deadlines: CodexDeadlines;
}>;

export function createCodexHarness(deps: CodexHarnessDeps): HarnessPort {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    return work.finally(() => inFlight.delete(work));
  };
  const attempted: AttemptedReleases = new Set();
  // Concurrent submits of one release share a single dispatch rather than racing the
  // queue check.
  const submitting = new Map<ReleaseId, Promise<DeliveryReceipt>>();

  return {
    async inspect(binding: SessionBinding): Promise<HarnessCapabilities> {
      if (closed) return unsupportedCapabilities('unknown', deps.limits);
      const probe = await track(probeBinding(binding, deps));
      if (!probe.ok) return unsupportedCapabilities('unknown', deps.limits);
      await probe.connection.close();
      return testedCapabilities(probe.host.cliVersion, deps.limits);
    },

    // Enqueueing already makes an idle thread start a turn; a hint never sends a
    // second prompt.
    async notify(): Promise<void> {},

    async submit({ job, payload }): Promise<DeliveryReceipt> {
      if (closed) {
        const target = { releaseId: job.releaseId, binding: job.binding };
        return makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode: 'harness_unavailable' });
      }
      const pending = submitting.get(job.releaseId);
      if (pending) return pending;
      const work = track(submitRelease(deps, attempted, job, payload))
        .finally(() => submitting.delete(job.releaseId));
      submitting.set(job.releaseId, work);
      return work;
    },

    async reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null> {
      if (closed) return null;
      return track(reconcileRelease(deps, job));
    },

    async close(): Promise<void> {
      closed = true;
      await withDeadline(Promise.allSettled([...inFlight]), deps.deadlines.closeMs, []);
    },
  };
}
