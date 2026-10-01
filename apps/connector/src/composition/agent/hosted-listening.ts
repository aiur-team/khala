import { sameSessionBinding, type HarnessCapabilities, type ListeningModeCommand, type ListeningModeResult, type ListeningModeView, type OwnerAuthority, type OwnerRouteGrantCommand, type SessionBinding } from '@khala/contracts/delivery/index';
import type { ConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { createAgentListeningModeAuthority } from './listening-mode-authority';
import { createHostedListeningModeStore } from '@khala/policy/listening-mode/hosted';
import { createListeningModeService, type ListeningModeReadResult } from '@khala/policy/listening-mode/store';
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
  owner: Readonly<{
    read(authority: OwnerAuthority): Promise<ListeningModeReadResult>;
    set(authority: OwnerAuthority, command: ListeningModeCommand): Promise<ListeningModeResult>;
    grant(authority: OwnerAuthority, command: OwnerRouteGrantCommand): Promise<Readonly<{
      commandId: OwnerRouteGrantCommand['commandId']; outcome: 'applied' | 'conflict' | 'refused';
      reason: string | null; view?: ListeningModeView;
    }>>;
  }>;
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
    const confirmed = async (target: { requested: 'steer' | 'sync' | 'async' | null;
      effective: 'steer' | 'sync' | 'async' | null; evidenceRevision: string | null },
    minimumVersion: number) => input.dispatch.ledger.transact(tx => {
      const state = tx.binding(binding.bindingId);
      const policy = tx.policy(binding.bindingId);
      return state !== null && !state.revoked && sameSessionBinding(state.binding, binding)
        && policy !== null && policy.listening.version >= minimumVersion
        && policy.listening.requested === target.requested
        && policy.listening.effective === target.effective
        && policy.listening.evidenceRevision === target.evidenceRevision;
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!await input.current()) return false;
      const policy = await input.dispatch.ledger.transact(tx => tx.policy(binding.bindingId));
      if (!policy) return false;
      const next = { requested: requested ?? policy.listening.requested,
        effective, evidenceRevision: effective === null ? null : evidenceRevision };
      if (policy.listening.version >= version && policy.listening.requested === next.requested
        && policy.listening.effective === next.effective
        && policy.listening.evidenceRevision === next.evidenceRevision) return confirmed(next, version);
      // The durable control command and the current capability evidence are distinct
      // revisions. A late hook proof or its loss must not rewrite an older ledger version.
      const writeVersion = Math.max(version, policy.listening.version + 1);
      const result = await input.dispatch.applyEffectivePolicy({ binding, policy: { ...policy,
        listening: { version: writeVersion, ...next },
      } });
      if (result.kind !== 'conflict') return confirmed(next, writeVersion);
      if (result.code !== 'stale_version' && result.code !== 'version_conflict') return false;
    }
    return false;
  }

  async function projectedRead(result: Awaited<ReturnType<typeof service.read>>) {
    if (!result.ok) return result;
    const { view } = result;
    const support = view.effective ? view.support[view.effective] : null;
    const evidenceRevision = support && 'evidenceRevision' in support ? support.evidenceRevision : null;
    const applied = await project(view.effective, view.requested, view.version, evidenceRevision);
    return applied ? result : { ok: true as const, view: { ...view, effective: null, effectiveReason: 'projection_unavailable' } };
  }
  async function read() { return projectedRead(await base.read()); }
  async function ownerRead(authority: OwnerAuthority) {
    if (!await input.current()) return { ok: false as const, code: 'unavailable' as const };
    return projectedRead(await service.read(authority, { binding, status: 'active' }, await input.capabilities()));
  }
  const application: AgentListeningModeApplication = {
    read,
    async set(command) {
      const result = await base.set(command);
      if (result.outcome !== 'applied') return result;
      const current = await read();
      const latest = await base.read();
      return current.ok && latest.ok && latest.view.version === result.version
        && latest.view.requested === result.requested && latest.view.effective === current.view.effective
        && current.view.version === result.version
        && current.view.requested === result.requested && current.view.effective !== null
        ? { ...result, effective: current.view.effective }
        : { ...result, effective: null, reason: current.ok ? current.view.effectiveReason : 'projection_unavailable' };
    },
  };
  return {
    application,
    owner: {
      read: ownerRead,
      async set(authority, command) {
        if (!await input.current()) return { v: 1 as const, commandId: command.commandId,
          bindingId: command.bindingId, generation: command.expectedBindingGeneration,
          outcome: 'refused' as const, version: command.expectedVersion,
          requested: command.requested, effective: null, reason: 'unavailable' };
        const capabilities = await input.capabilities();
        const support = capabilities?.modes[command.requested];
        if (!support || (support.status !== 'proven' && support.status !== 'experimental')) {
          return { v: 1 as const, commandId: command.commandId, bindingId: command.bindingId,
            generation: command.expectedBindingGeneration, outcome: 'refused' as const,
            version: command.expectedVersion, requested: command.requested, effective: null,
            reason: support?.reason ?? 'capabilities_unavailable' };
        }
        const result = await service.set(authority, { binding, status: 'active' }, capabilities, command);
        if (result.outcome !== 'applied') return result;
        const current = await ownerRead(authority);
        const latest = await service.read(authority, { binding, status: 'active' }, await input.capabilities());
        return current.ok && latest.ok && latest.view.version === result.version
          && latest.view.requested === command.requested && latest.view.effective === current.view.effective
          && current.view.version === result.version
          && current.view.requested === command.requested
          ? { ...result, effective: current.view.effective, reason: current.view.effectiveReason }
          : { ...result, effective: null, reason: 'projection_unavailable' };
      },
      async grant(authority, command) {
        if (!await input.current()) return { commandId: command.commandId,
          outcome: 'refused' as const, reason: 'unavailable' };
        const capabilities = await input.capabilities();
        const context = { binding, status: 'active' as const };
        const result = command.kind === 'grant_experimental_route'
          ? await service.grantExperimentalRoute(authority, context, capabilities, command)
          : command.kind === 'revoke_experimental_route'
            ? await service.revokeExperimentalRoute(authority, context, capabilities, command)
            : command.kind === 'grant_hard_cancel'
              ? await service.grantHardCancel(authority, context, capabilities, command)
              : await service.revokeHardCancel(authority, context, capabilities, command);
        if (result.outcome === 'refused') return { commandId: command.commandId, ...result };
        const projected = await projectedRead({ ok: true, view: result.view });
        return projected.ok && projected.view.version === result.view.version
          && projected.view.requested === result.view.requested
          ? { commandId: command.commandId, ...result, view: projected.view }
          : { commandId: command.commandId, outcome: 'refused' as const, reason: 'projection_unavailable' };
      },
    },
    async status() {
      const result = await read();
      return { v: 1, bindingId: binding.bindingId, generation: binding.generation,
        effective: result.ok ? result.view.effective : null };
    },
  };
}
