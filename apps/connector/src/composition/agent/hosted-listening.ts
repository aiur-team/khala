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
    if (!await input.current()) return false;
    const policy = await input.dispatch.ledger.transact(tx => tx.policy(binding.bindingId));
    if (!policy) return false;
    const result = await input.dispatch.applyEffectivePolicy({ binding, policy: { ...policy,
      listening: { version, requested: requested ?? policy.listening.requested,
        effective, evidenceRevision: effective === null ? null : evidenceRevision },
    } });
    return result.kind === 'applied' || result.kind === 'duplicate';
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
      return current.ok && current.view.effective !== null ? { ...result, effective: current.view.effective }
        : { ...result, effective: null, reason: current.ok ? current.view.effectiveReason : 'projection_unavailable' };
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
