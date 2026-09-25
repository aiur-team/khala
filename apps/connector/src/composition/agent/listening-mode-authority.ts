import {
  createAgentListeningModeApplication,
  type AgentListeningModeApplication,
  type AgentListeningModePort,
} from '@khala/connector/agent/listening-mode';
import type {
  AgentBindingAuthority,
  BindingId,
  HarnessCapabilities,
  SessionBinding,
} from '@khala/contracts/delivery/index';
import {
  refusedListeningModeResult,
  type ListeningModeService,
} from '@khala/policy/listening-mode/store';

export type AgentListeningModeContext = Readonly<{
  kind: 'current';
  binding: SessionBinding;
  status: 'active' | 'revoked';
  capabilities: HarnessCapabilities | null;
}>;

/** Resolves the authoritative current binding, never request-carried state. */
export interface AgentListeningModeContextPort {
  resolve(bindingId: BindingId): Promise<AgentListeningModeContext | Readonly<{ kind: 'unavailable' }>>;
}

function authorityFor(binding: SessionBinding): AgentBindingAuthority {
  return {
    kind: 'agent_binding',
    bindingId: binding.bindingId,
    generation: binding.generation,
  } as AgentBindingAuthority;
}

/** Trusted composition is the only place that constructs agent authority. */
export function createAgentListeningModeAuthority(
  heldBinding: SessionBinding,
  contexts: AgentListeningModeContextPort,
  service: Pick<ListeningModeService, 'read' | 'set'>,
): AgentListeningModeApplication {
  const port: AgentListeningModePort = {
    async read(authority) {
      const current = await contexts.resolve(heldBinding.bindingId);
      if (current.kind === 'unavailable') return { ok: false, code: 'unavailable' };
      return service.read(authority, {
        binding: current.binding,
        status: current.status,
      }, current.capabilities);
    },
    async set(authority, command) {
      const current = await contexts.resolve(heldBinding.bindingId);
      if (current.kind === 'unavailable') {
        return refusedListeningModeResult(command, 'unavailable');
      }
      return service.set(authority, {
        binding: current.binding,
        status: current.status,
      }, current.capabilities, command);
    },
  };
  return createAgentListeningModeApplication(authorityFor(heldBinding), port);
}
