import type { HarnessCapabilities, SessionBinding } from '@khala/contracts/delivery/index';
import type { ConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { createAgentListeningModeAuthority } from './listening-mode-authority';
import { createHostedListeningModeStore } from '@khala/policy/listening-mode/hosted';
import { createListeningModeService } from '@khala/policy/listening-mode/store';
import type { AgentListeningModeApplication } from '@khala/connector/agent/listening-mode';
import type { TrustStateStore } from '../controls/control-handler';
import type { TrustState } from '@khala/policy/trust/index';

/** A mode is effective only after the same connector ledger used by dispatch accepts it. */
export function createHostedListeningControl(input: Readonly<{
  binding: SessionBinding;
  trust: TrustStateStore & {
    snapshot(bindingId: SessionBinding['bindingId']): Promise<Readonly<{ revision: string; state: TrustState }> | null>;
    compareAndSet(bindingId: SessionBinding['bindingId'], revision: string, state: TrustState): Promise<'applied' | 'conflict'>;
  };
  dispatch: ConnectorDispatchStorage;
  current(): Promise<boolean>;
  capabilities(): Promise<HarnessCapabilities | null>;
}>): Readonly<{
  application: AgentListeningModeApplication;
  status(): Promise<Readonly<{ v: 1; bindingId: SessionBinding['bindingId']; generation: number; effective: 'steer' | 'sync' | 'async' | null }>>;
}> {
  const binding = input.binding;
  const host = {
    async read() {
      try {
        const snapshot = await input.trust.snapshot(binding.bindingId);
        return snapshot ? { kind: 'record' as const, snapshot } : { kind: 'unavailable' as const };
      } catch { return { kind: 'unavailable' as const }; }
    },
    async compareAndSet(revision: string, state: TrustState) {
      try {
        const result = await input.trust.compareAndSet(binding.bindingId, revision, state);
        return result === 'applied' ? { kind: 'applied' as const, revision: '' } : { kind: 'conflict' as const };
      } catch { return { kind: 'unavailable' as const }; }
    },
  };
  const service = createListeningModeService(createHostedListeningModeStore(host));
  const base = createAgentListeningModeAuthority(binding, {
    async resolve(bindingId) {
      if (bindingId !== binding.bindingId || !await input.current()) return { kind: 'unavailable' };
      return { kind: 'current', binding, status: 'active', capabilities: await input.capabilities() };
    },
  }, service);

  async function project(effective: 'steer' | 'sync' | 'async' | null,
    requested: 'steer' | 'sync' | 'async' | null, version: number,
    evidenceRevision: string | null): Promise<boolean> {
    const confirmed = async () => {
      if (!await input.current()) return false;
      const stored = await input.dispatch.ledger.transact(tx => tx.policy(binding.bindingId));
      return stored?.listening.requested === requested && stored.listening.effective === effective
        && stored.listening.evidenceRevision === (effective === null ? null : evidenceRevision);
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!await input.current()) return false;
      const policy = await input.dispatch.ledger.transact(tx => tx.policy(binding.bindingId));
      if (!policy) return false;
      const next = { requested: requested ?? policy.listening.requested,
        effective, evidenceRevision: effective === null ? null : evidenceRevision };
      if (policy.listening.version >= version && policy.listening.requested === next.requested
        && policy.listening.effective === next.effective
        && policy.listening.evidenceRevision === next.evidenceRevision) return confirmed();
      // The durable control command and the current capability evidence are distinct
      // revisions. A late hook proof or its loss must not rewrite an older ledger version.
      const result = await input.dispatch.applyEffectivePolicy({ binding, policy: { ...policy,
        listening: { version: Math.max(version, policy.listening.version + 1), ...next },
      } });
      if (result.kind !== 'conflict') return confirmed();
      if (result.code !== 'stale_version' && result.code !== 'version_conflict') return false;
    }
    return false;
  }

  async function read() {
    const result = await base.read();
    if (!result.ok) return result;
    const { view } = result;
    const support = view.effective ? view.support[view.effective] : null;
    const evidenceRevision = support && 'evidenceRevision' in support ? support.evidenceRevision : null;
    const applied = await project(view.effective, view.requested, view.version, evidenceRevision);
    return applied ? result : { ok: true as const, view: { ...view, effective: null, effectiveReason: 'projection_unavailable' } };
  }
  const application: AgentListeningModeApplication = {
    read,
    async set(command) {
      const result = await base.set(command);
      if (result.outcome !== 'applied') return result;
      const current = await read();
      if (!current.ok || current.view.version !== result.version || current.view.requested !== result.requested) {
        return { ...result, effective: null, reason: 'projection_unavailable' };
      }
      return { ...result, effective: current.view.effective, reason: current.view.effectiveReason };
    },
  };
  return {
    application,
    async status() {
      const result = await read();
      return { v: 1, bindingId: binding.bindingId, generation: binding.generation,
        effective: result.ok ? result.view.effective : null };
    },
  };
}
