// Claude harness adapter (KHA-117, amended by KHA-149). KHA-145 proved neither
// native candidate meets the existing-session contract, so this adapter keeps one
// injected route seam but fails closed before invoking it.

import {
  type BindingId, type Clock, type DeliveryLimits, type DeliveryReceipt, type HarnessPort, type ReleaseId,
} from '@khala/contracts/delivery/index';
import { CLAUDE_HARNESS, claudeCapabilities } from './capabilities';
import type { ClaudeNativeProbe, ClaudeNativeRoutePort } from './native-cli';
import { failedReceipt } from './receipts';
import { type InspectedClaudeBinding, submitRelease } from './transport';

export {
  CLAUDE_ADAPTER_VERSION, CLAUDE_EVIDENCE_REF, CLAUDE_HARNESS, CLAUDE_TESTED_VERSION, claudeCapabilities,
} from './capabilities';
export type {
  ClaudeNativeProbe, ClaudeNativeRouteOutcome, ClaudeNativeRoutePort, ClaudeRouteSubmission, ClaudeSessionState,
} from './native-cli';

export type ClaudeHarnessDeps = Readonly<{
  probe: ClaudeNativeProbe;
  route: ClaudeNativeRoutePort;
  clock: Clock;
  /** From configuration or the capability record; the adapter has no default. */
  limits: DeliveryLimits;
}>;

export function createClaudeHarness(deps: ClaudeHarnessDeps): HarnessPort {
  const { probe, clock, limits } = deps;
  // The binding each ID was last inspected at. Losing this map on restart only
  // forces a fresh inspection; it never permits a send.
  const inspected = new Map<BindingId, InspectedClaudeBinding>();
  const submitting = new Map<ReleaseId, Promise<DeliveryReceipt>>();
  let closed = false;

  return {
    async inspect(binding) {
      if (closed) throw new Error('claude adapter is closed');
      if (binding.harness !== CLAUDE_HARNESS) throw new Error('claude adapter: binding names another harness');
      inspected.delete(binding.bindingId);
      const [version, session] = await Promise.all([probe.installedVersion(), probe.session(binding.sessionId)]);
      inspected.set(binding.bindingId, { binding, session });
      return claudeCapabilities(version, limits);
    },

    // No route is proven, so a hint must never reach the model.
    async notify() {},

    async submit({ job, payload }) {
      const pending = submitting.get(job.releaseId);
      if (pending) return pending;
      if (closed) return failedReceipt(job, 'harness_unavailable', clock);
      const work = submitRelease(deps, inspected.get(job.binding.bindingId), job, payload)
        .finally(() => submitting.delete(job.releaseId));
      submitting.set(job.releaseId, work);
      return work;
    },

    // Reconciliation by release ID is unsupported. `null` means "no evidence" and
    // never licenses a second submission.
    async reconcile() {
      return null;
    },

    async close() {
      closed = true;
      inspected.clear();
    },
  };
}
