// Codex harness adapter for Khala-hosted app-server delivery and native CLI
// notification into an externally owned thread backed by the local inbox.

import {
  type DeliveryLimits, type DeliveryReceipt, type HarnessCapabilities, type HarnessPort, type ReleasedJob,
  type ReleaseId, type SessionBinding, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import {
  TESTED_CODEX_VERSIONS, nativeCliCapabilities, probeBinding, testedCapabilities, unsupportedCapabilities,
  unsupportedNativeCliCapabilities,
} from './capabilities';
import {
  type CodexNativeCliPort, type CodexNativeInboxPort, probeNativeCli, submitNativeRelease,
} from './native-cli';
import { type CodexClientPort, type CodexDeadlines, type CodexHostPort, withDeadline } from './native';
import { reconcileRelease } from './reconcile';
import { type Clock, type EvidenceSink, makeReceipt } from './receipts';
import { type AttemptedReleases, type ReleaseCodecPort, submitRelease } from './transport';

export {
  CODEX_ADAPTER_VERSION, CODEX_EVIDENCE_REF, CODEX_HARNESS, CODEX_NATIVE_CLI_ADAPTER_VERSION,
  CODEX_NATIVE_CLI_EVIDENCE_REF, CODEX_NATIVE_CLI_RECEIPT_EVIDENCE, CODEX_RECEIPT_EVIDENCE,
  TESTED_CODEX_VERSIONS, type ProbeFailure, probeBinding,
} from './capabilities';
export type {
  CodexNativeCliInspection, CodexNativeCliOutcome, CodexNativeCliPort, CodexNativeInboxDelivery,
  CodexNativeInboxPort, CodexNativeSessionState,
} from './native-cli';
export type {
  CodexClientPort, CodexConnection, CodexDeadlines, CodexEndpoint, CodexHost, CodexHostPort, CodexMethod,
  CodexRequestOutcome,
} from './native';
export {
  type Clock, type CodexReceiptTracker, type EvidenceSink, type NativeNotification, createCodexReceiptTracker,
  receiptIdFor,
} from './receipts';
export type { ReleaseCodecPort } from './transport';
export {
  CODEX_IDLE_WAKE_NOTICE, codexIdleWakeArgv, createCodexIdleWake,
  type CodexIdleWake, type CodexIdleWakeDeps, type CodexIdleWakeOutcome, type CodexIdleWakePort,
  type CodexIdleWakeResult,
} from './idle-wake';

type CodexHarnessBaseDeps = Readonly<{
  client: CodexClientPort;
  hosts: CodexHostPort;
  codec: ReleaseCodecPort;
  clock: Clock;
  evidence: EvidenceSink;
  limits: DeliveryLimits;
  deadlines: CodexDeadlines;
}>;

export type CodexHarnessDeps = CodexHarnessBaseDeps & (
  | Readonly<{ nativeCli: CodexNativeCliPort; nativeInbox: CodexNativeInboxPort }>
  | Readonly<{ nativeCli?: never; nativeInbox?: never }>
);

type SelectedRoute = Readonly<{
  binding: SessionBinding;
  capabilities: HarnessCapabilities;
  route: 'hosted' | 'native';
}>;

export function createCodexHarness(deps: CodexHarnessDeps): HarnessPort {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    return work.finally(() => inFlight.delete(work));
  };
  const attempted: AttemptedReleases = new Set();
  const selected = new Map<string, SelectedRoute>();
  const nativeDeps = deps.nativeCli && deps.nativeInbox
    ? { ...deps, nativeCli: deps.nativeCli, nativeInbox: deps.nativeInbox }
    : null;
  // Concurrent submits of one release share a single dispatch rather than racing the
  // queue check.
  const submitting = new Map<ReleaseId, Promise<DeliveryReceipt>>();

  return {
    async inspect(binding: SessionBinding): Promise<HarnessCapabilities> {
      if (closed) return unsupportedCapabilities('unknown', deps.limits);
      const current = selected.get(binding.bindingId);
      if (current && sameSessionBinding(current.binding, binding)) return current.capabilities;
      if (current) selected.delete(binding.bindingId);

      const probe = await track(probeBinding(binding, deps));
      if (probe.ok) {
        const capabilities = testedCapabilities(probe.host.cliVersion, deps.limits);
        selected.set(binding.bindingId, { binding, capabilities, route: 'hosted' });
        await probe.connection.close();
        return capabilities;
      }
      if (!nativeDeps || probe.reason !== 'no_host') {
        return unsupportedCapabilities('unknown', deps.limits);
      }
      const native = await track(probeNativeCli(binding, nativeDeps));
      if (!native.ok) {
        return unsupportedNativeCliCapabilities('unknown', deps.limits);
      }
      if (
        !TESTED_CODEX_VERSIONS.includes(native.version)
        || native.platform !== 'linux'
        || native.arch !== 'x64'
      ) {
        return unsupportedNativeCliCapabilities(native.version, deps.limits);
      }
      const capabilities = nativeCliCapabilities(native.version, deps.limits);
      selected.set(binding.bindingId, { binding, capabilities, route: 'native' });
      return capabilities;
    },

    // Enqueueing already makes an idle thread start a turn; a hint never sends a
    // second prompt.
    async notify(): Promise<void> {},

    async submit({ job, payload }): Promise<DeliveryReceipt> {
      // A submission already in flight is joined even if close() lands concurrently: the
      // dispatch it started may still reach the listener, so its real outcome — not a
      // synthesized failed — must be what every caller of this release ID sees.
      const pending = submitting.get(job.releaseId);
      if (pending) return pending;
      if (closed) {
        const target = { releaseId: job.releaseId, binding: job.binding };
        // A repeat submit against a closed adapter is a pre-send refusal like the ones in
        // transport.ts: uncertain, not a definite failure a caller could read as clear to retry.
        if (attempted.has(job.releaseId)) return makeReceipt(target, 'outcome_unknown', deps.clock, { source: 'connector' });
        return makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode: 'harness_unavailable' });
      }
      const route = selected.get(job.binding.bindingId);
      let dispatch: Promise<DeliveryReceipt>;
      if (route?.route === 'native' && nativeDeps) {
        dispatch = submitNativeRelease(nativeDeps, attempted, route.binding, job, payload);
      } else if (route?.route === 'hosted' || !nativeDeps) {
        dispatch = submitRelease(deps, attempted, job, payload);
      } else {
        dispatch = Promise.resolve(makeReceipt(
          { releaseId: job.releaseId, binding: job.binding },
          'failed',
          deps.clock,
          { source: 'connector', errorCode: 'harness_unavailable' },
        ));
      }
      const work = track(dispatch)
        .finally(() => submitting.delete(job.releaseId));
      submitting.set(job.releaseId, work);
      return work;
    },

    async reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null> {
      if (closed) return null;
      const route = selected.get(job.binding.bindingId)?.route;
      if (route === 'native') return null;
      if (nativeDeps && route !== 'hosted') return null;
      return track(reconcileRelease(deps, job));
    },

    async close(): Promise<void> {
      closed = true;
      selected.clear();
      await withDeadline(Promise.allSettled([...inFlight]), deps.deadlines.closeMs, []);
    },
  };
}
