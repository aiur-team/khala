import { MAX_SEND_BYTES } from '@aiur/khala/cli/send';
import { localHarness } from '@aiur/khala/composition/local-harness-capabilities';
import { setupEnvironment } from '@aiur/khala/setup/environment';
import { randomBytes } from 'node:crypto';
import { type HarnessCapabilities, type SessionBinding, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { claudeCapabilities } from '@khala/harnesses/claude/capabilities';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { installedOpenCodeCapabilities } from '@khala/harnesses/opencode/interactive';
import type { HarnessObservation } from '../../server/binding-mode';
import type { InternalStoreHandle } from '../../store/open';

// The harness claim the internal server projects a binding's mode through for the
// owner. The launcher inspects the Claude Code installed beside it once per launch
// and passes that claim in, so the owner sees and grants exactly the route the
// Claude session adapter serves; without one, Claude is unproven. A Codex claim
// depends on the version and hook trust that the agent's own machine shows, so
// the agent's CLI reports that observation and the claim is derived here from the
// released proof matrix: an unproven version or untrusted hooks claim nothing, and
// without a shipped receipt proof `async` stays unproven. Before any report the
// Codex claim is unknown. An idle wake rechecks the owner's local installation
// against the exact persisted observation before queueing. OpenCode is claimed
// from the version its installed plugin reports: proven only for an exact
// version with retained route evidence, experimental for any other version,
// and unknown before the plugin reports.

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
  revalidateCodex(binding: SessionBinding): Promise<boolean>;
}>;

type PersistedObservation = Readonly<{
  v: 1 | 2; harness: 'codex'; ownerId: string; agentParticipantId: string; deviceId: string;
  sessionId: string; version: string; hookReview: HarnessObservation['hookReview'];
  platform?: string; arch?: string;
}>;
type ObservationRow = Readonly<{ value: string }>;
const agentRuntime = (observation: HarnessObservation) => ({
  platform: observation.platform ?? 'unobserved', arch: observation.arch ?? 'unobserved',
});

/** The agent's exact binding observation survives an owner restart, but is never a live capability by itself. */
export function createServerHarnessCapabilities(
  claude: HarnessCapabilities = claudeCapabilities(null, LIMITS),
  options: Readonly<{ handle?: InternalStoreHandle; inspectCodex?: (binding: SessionBinding) => Promise<HarnessObservation | null> }> = {},
): ServerHarnessCapabilities {
  const observed = new Map<string, HarnessObservation>();
  const key = (binding: SessionBinding) => JSON.stringify([
    binding.bindingId, binding.generation, binding.ownerId, binding.agentParticipantId,
    binding.deviceId, binding.sessionId,
  ]);
  const recordKey = (binding: SessionBinding) => `codex-harness-observation:v1:${key(binding)}`;
  const inspectCodex = options.inspectCodex ?? (async (binding: SessionBinding) =>
    localHarness(() => setupEnvironment(process.env)).observation(binding));
  return {
    capabilities(binding) {
      if (binding.harness === claude.harness) return claude;
      if (binding.harness !== 'codex' && binding.harness !== 'opencode') return null;
      const observation = observed.get(key(binding));
      if (observation === undefined) return null;
      // The plugin is the route, so OpenCode has no hook review to consult.
      if (binding.harness === 'opencode') return installedOpenCodeCapabilities(observation.version, LIMITS);
      return interactiveCodexCapabilities(observation.version, LIMITS, observation.hookReview === 'trusted'
        ? { state: 'trusted' }
        : { state: observation.hookReview, reason: REVIEW_REASONS[observation.hookReview] },
      undefined, undefined, agentRuntime(observation));
    },
    observe(binding, observation) {
      if (binding.harness === 'codex' && options.handle) {
        const value: PersistedObservation = { v: observation.platform && observation.arch ? 2 : 1,
          harness: 'codex', ownerId: binding.ownerId,
          agentParticipantId: binding.agentParticipantId, deviceId: binding.deviceId, sessionId: binding.sessionId,
          version: observation.version, hookReview: observation.hookReview,
          ...(observation.platform && observation.arch
            ? { platform: observation.platform, arch: observation.arch } : {}) };
        options.handle.transaction(db => db.prepare(`
          INSERT INTO control_records (record_key, revision, operation_id, value, expires_at) VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT (record_key) DO UPDATE SET revision = excluded.revision,
            operation_id = excluded.operation_id, value = excluded.value, expires_at = NULL
        `).run(recordKey(binding), `crev_${randomBytes(16).toString('base64url')}`,
          `harness_${randomBytes(16).toString('base64url')}`, JSON.stringify(value)));
      }
      if (binding.harness === 'codex' || binding.harness === 'opencode') observed.set(key(binding), observation);
    },
    async revalidateCodex(binding) {
      if (binding.harness !== 'codex' || !options.handle) return false;
      observed.delete(key(binding));
      let record: PersistedObservation;
      try {
        const row = options.handle.read(db => db.prepare('SELECT value FROM control_records WHERE record_key = ?')
          .get(recordKey(binding)) as ObservationRow | undefined);
        if (!row || row.value.length > 1024) return false;
        const value: unknown = JSON.parse(row.value);
        if (!value || typeof value !== 'object') return false;
        record = value as PersistedObservation;
        if ((record.v !== 1 && record.v !== 2) || record.harness !== 'codex' || record.ownerId !== binding.ownerId
          || record.agentParticipantId !== binding.agentParticipantId || record.deviceId !== binding.deviceId
          || record.sessionId !== binding.sessionId
          || typeof record.version !== 'string' || record.hookReview !== 'trusted'
          || (record.v === 1 && (record.platform !== undefined || record.arch !== undefined))
          || (record.v === 2 && (typeof record.platform !== 'string' || typeof record.arch !== 'string'))) return false;
      } catch { return false; }
      const current = await inspectCodex(binding).catch(() => null);
      if (current?.version !== record.version || current.hookReview !== 'trusted'
        || current.platform !== record.platform || current.arch !== record.arch) return false;
      if (interactiveCodexCapabilities(record.version, LIMITS, { state: 'trusted' }, undefined, undefined,
        agentRuntime(record)).support !== 'tested') return false;
      observed.set(key(binding), { version: record.version, hookReview: 'trusted',
        ...(record.v === 2 ? { platform: record.platform, arch: record.arch } : {}) });
      return true;
    },
  };
}
