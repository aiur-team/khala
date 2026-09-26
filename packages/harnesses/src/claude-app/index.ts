// Claude app adapter (E09 `claude-app-channel-adapter`). Claude Desktop and
// claude.ai pull batches through `khala_read`; Khala has no proven way to put
// anything into their conversation, so the port reports capabilities and refuses
// every push. It never launches, drives or messages the app.

import type { Clock, DeliveryLimits, HarnessPort } from '@khala/contracts/delivery/index';
import { CLAUDE_APP_HARNESS, type ClaudeAppObservation, claudeAppRecord } from './capabilities';
import { CLAUDE_APP_EVIDENCE, type ClaudeAppEvidence } from './evidence';
import { failedReceipt } from './receipts';

export {
  CLAUDE_APP_ADAPTER_VERSION, CLAUDE_APP_HARNESS, type ClaudeAppObservation, claudeAppIdentity, claudeAppRecord,
} from './capabilities';
export {
  CLAUDE_APP_DELIVERIES, CLAUDE_APP_EVIDENCE, CLAUDE_APP_PROOF_REF, CLAUDE_APP_SHAPES, type ClaudeAppDelivery,
  type ClaudeAppEvidence, type ClaudeAppShape, admittedEvidence, identityComplete,
} from './evidence';

export type ClaudeAppHarnessDeps = Readonly<{
  /** Read-only inspection of the one app shape this binding runs in. */
  observe: () => Promise<ClaudeAppObservation>;
  clock: Clock;
  limits: DeliveryLimits;
  evidence?: readonly ClaudeAppEvidence[];
}>;

export function createClaudeAppHarness(deps: ClaudeAppHarnessDeps): HarnessPort {
  const { clock, limits, evidence = CLAUDE_APP_EVIDENCE } = deps;
  let closed = false;

  return {
    async inspect(binding) {
      if (closed) throw new Error('claude app adapter is closed');
      if (binding.harness !== CLAUDE_APP_HARNESS) throw new Error('claude app adapter: binding names another harness');
      return claudeAppRecord(await deps.observe(), limits, evidence).capabilities;
    },

    // A notification is not model context and never stands in for a push mode.
    async notify() {},

    // The app reads through `khala_read`; there is no push boundary to submit to.
    async submit({ job }) {
      return failedReceipt(job, 'harness_unavailable', clock);
    },

    // `null` means "no evidence" and never licenses a second submission.
    async reconcile() {
      return null;
    },

    async close() {
      closed = true;
    },
  };
}
