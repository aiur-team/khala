// Codex harness adapter (KHA-118) for the one route KHA-104 proved: a thread hosted
// by a Khala-started `codex app-server`, delivered through `thread/queue/add`.
// KHA-133 composes the native client, host registry and stores.

import type {
  DeliveryLimits, DeliveryReceipt, HarnessCapabilities, HarnessPort, ReleasedJob, SessionBinding,
} from '@khala/contracts/delivery/index';
import { probeBinding, testedCapabilities, unsupportedCapabilities } from './capabilities';
import type { CodexClientPort, CodexHostPort } from './native';
import { reconcileRelease } from './reconcile';
import { type Clock, type EvidenceSink, makeReceipt } from './receipts';
import { type ReleaseCodecPort, submitRelease } from './transport';

export {
  CODEX_ADAPTER_VERSION, CODEX_EVIDENCE_REF, CODEX_HARNESS, TESTED_CODEX_VERSIONS, type ProbeFailure, probeBinding,
} from './capabilities';
export type {
  CodexClientPort, CodexConnection, CodexEndpoint, CodexHost, CodexHostPort, CodexMethod, CodexRequestOutcome,
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
}>;

export function createCodexHarness(deps: CodexHarnessDeps): HarnessPort {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    return work.finally(() => inFlight.delete(work));
  };

  return {
    async inspect(binding: SessionBinding): Promise<HarnessCapabilities> {
      if (closed) return unsupportedCapabilities('unknown', deps.limits);
      const probe = await track(probeBinding(binding, deps.hosts, deps.client));
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
      return track(submitRelease(deps, job, payload));
    },

    async reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null> {
      if (closed) return null;
      return track(reconcileRelease(deps, job));
    },

    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...inFlight]);
    },
  };
}
