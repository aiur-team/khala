import type {
  AgentBindingAuthority,
  ListeningModeCommand,
  ListeningModeResult,
  ListeningModeView,
} from '@khala/contracts/delivery/index';

export type AgentListeningModeReadResult =
  | Readonly<{ ok: true; view: ListeningModeView }>
  | Readonly<{
      ok: false;
      code: 'forbidden' | 'binding_mismatch' | 'stale_binding' | 'binding_revoked' | 'unavailable';
    }>;

/** Trusted application port; composition injects authorization and persistence. */
export interface AgentListeningModePort {
  read(authority: AgentBindingAuthority): Promise<AgentListeningModeReadResult>;
  set(authority: AgentBindingAuthority, command: ListeningModeCommand): Promise<ListeningModeResult>;
}

export type AgentListeningModeSetInput = Omit<
  ListeningModeCommand,
  'v' | 'bindingId' | 'expectedBindingGeneration'
>;

/** Agent-facing surface deliberately contains no target or grant operation. */
export interface AgentListeningModeApplication {
  read(): Promise<AgentListeningModeReadResult>;
  set(input: AgentListeningModeSetInput): Promise<ListeningModeResult>;
}

export function createAgentListeningModeApplication(
  authority: AgentBindingAuthority,
  port: AgentListeningModePort,
): AgentListeningModeApplication {
  return {
    read: () => port.read(authority),
    set: input => port.set(authority, {
      v: 1,
      commandId: input.commandId,
      bindingId: authority.bindingId,
      expectedBindingGeneration: authority.generation,
      expectedVersion: input.expectedVersion,
      requested: input.requested,
      issuedAt: input.issuedAt,
    }),
  };
}
