// Claude harness adapter (KHA-117). KHA-103 found no Claude route that meets the
// no-setup contract, so this adapter fails closed: it reports the evidence-pinned
// capabilities and refuses every submission. It never starts, resumes, restarts or
// messages Claude, and released bytes never leave this module.

import { createHash } from 'node:crypto';
import {
  type BindingId, type DeliveryLimits, type DeliveryReceipt, type HarnessPort, type ReceiptErrorCode,
  type SessionBinding, sameSessionBinding, validatePayloadBytes,
} from '@khala/contracts/delivery/index';
import { CLAUDE_HARNESS, claudeCapabilities } from './capabilities';
import type { ClaudeNativeProbe, ClaudeSessionState } from './native';
import { failedReceipt } from './receipts';

export {
  CLAUDE_ADAPTER_VERSION, CLAUDE_EVIDENCE_REF, CLAUDE_HARNESS, CLAUDE_TESTED_VERSION, claudeCapabilities,
} from './capabilities';
export type { ClaudeNativeProbe, ClaudeSessionState } from './native';

export type ClaudeHarnessDeps = Readonly<{
  probe: ClaudeNativeProbe;
  clock: () => Date;
  /** From configuration or the capability record; the adapter has no default. */
  limits: DeliveryLimits;
}>;

type Inspected = Readonly<{ binding: SessionBinding; session: ClaudeSessionState }>;

export function createClaudeHarness(deps: ClaudeHarnessDeps): HarnessPort {
  const { probe, clock, limits } = deps;
  // The binding each ID was last inspected at. Losing this map on restart only
  // forces a fresh inspection; it never permits a send.
  const inspected = new Map<BindingId, Inspected>();
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
      const fail = (code: ReceiptErrorCode): DeliveryReceipt => failedReceipt(job, code, clock());
      if (closed) return fail('harness_unavailable');
      const current = inspected.get(job.binding.bindingId);
      if (!current) return fail('session_unavailable');
      if (!sameSessionBinding(current.binding, job.binding)) return fail('stale_binding');
      if (current.session !== 'present') return fail('session_unavailable');
      const bytes = validatePayloadBytes(payload, limits);
      if (!bytes.ok) return fail(bytes.code === 'limit_exceeded' ? 'limit_exceeded' : 'payload_digest_mismatch');
      if (sha256(bytes.value) !== job.payloadDigest) return fail('payload_digest_mismatch');
      // Every check passed, but KHA-103 proved no delivery route. Refuse rather than
      // launch a replacement session or ask the owner for setup.
      return fail('harness_unavailable');
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

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
