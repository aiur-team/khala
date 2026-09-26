import { MAX_SEND_BYTES } from '@aiur/khala/cli/send';
import { type HarnessCapabilities, type SessionBinding, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { claudeCapabilities } from '@khala/harnesses/claude/capabilities';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import type { HarnessObservation } from '../../server/binding-mode';

// The harness claim the internal server projects a binding's mode through for the
// owner. The launcher inspects the Claude Code installed beside it once per launch
// and passes that claim in, so the owner sees and grants exactly the route the
// Claude session adapter serves; without one, Claude is unproven. A Codex claim
// depends on the version and hook trust that only the agent's own machine shows, so
// the agent's CLI reports that observation and the claim is derived here from the
// released proof matrix: an unproven version or untrusted hooks claim nothing, and
// without a shipped receipt proof `async` stays unproven. Before any report the
// Codex claim is unknown.

const limits = decodeDeliveryLimits({ maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32 });
if (!limits.ok) throw new Error('binding modes: invalid delivery limits');
const LIMITS = limits.value;

const REVIEW_REASONS = {
  awaiting_hook_review: 'The agent reports that Codex has not trusted the Khala hooks yet.',
  unknown: 'The agent could not tell whether Codex trusts the Khala hooks.',
} as const;

export type ServerHarnessCapabilities = Readonly<{
  capabilities(binding: SessionBinding): HarnessCapabilities | null;
  observe(binding: SessionBinding, observation: HarnessObservation): void;
}>;

/** Observations last for this server's lifetime; an agent reports again on its next Khala call. */
export function createServerHarnessCapabilities(claude: HarnessCapabilities = claudeCapabilities(null, LIMITS)): ServerHarnessCapabilities {
  const observed = new Map<string, HarnessObservation>();
  const key = (binding: SessionBinding) => JSON.stringify([binding.bindingId, binding.generation]);
  return {
    capabilities(binding) {
      if (binding.harness === claude.harness) return claude;
      if (binding.harness !== 'codex') return null;
      const observation = observed.get(key(binding));
      if (observation === undefined) return null;
      return interactiveCodexCapabilities(observation.version, LIMITS, observation.hookReview === 'trusted'
        ? { state: 'trusted' }
        : { state: observation.hookReview, reason: REVIEW_REASONS[observation.hookReview] });
    },
    observe(binding, observation) {
      if (binding.harness === 'codex') observed.set(key(binding), observation);
    },
  };
}
