import type { SessionBinding } from '@khala/contracts/delivery/index';

export const CONNECTOR_CAPABILITY_IDS = ['review', 'controls', 'recovery'] as const;
export type ConnectorCapabilityId = (typeof CONNECTOR_CAPABILITY_IDS)[number];

export interface RuntimeLedgerPort {
  readonly runtimeLedgerPort?: true;
}

export interface RuntimeDispatcherPort {
  reconcilePending(): Promise<void>;
  setEnabled(enabled: boolean): void;
  stop(): Promise<void>;
}

export interface ConnectorCapability {
  readonly id: ConnectorCapabilityId;
  readonly state: 'unavailable' | 'ready';
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ConnectorCapabilityContext {
  readonly binding: SessionBinding;
  readonly ledger: RuntimeLedgerPort;
  readonly dispatcher: RuntimeDispatcherPort;
  readonly clock: () => number;
  prerequisiteChanged(id: ConnectorCapabilityId): void;
}

export type ConnectorCapabilityRegistration = (
  context: ConnectorCapabilityContext,
) => ConnectorCapability;

export function validateCapabilityRegistry(
  capabilities: readonly ConnectorCapability[],
): readonly ConnectorCapability[] {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (!CONNECTOR_CAPABILITY_IDS.includes(capability.id)) {
      throw new Error(`unknown capability: ${String(capability.id)}`);
    }
    if (seen.has(capability.id)) throw new Error(`duplicate capability: ${capability.id}`);
    seen.add(capability.id);
  }
  for (const id of CONNECTOR_CAPABILITY_IDS) {
    if (!seen.has(id)) throw new Error(`missing capability: ${id}`);
  }
  return Object.freeze([...capabilities]);
}

export function unavailableCapability(id: ConnectorCapabilityId): ConnectorCapability {
  return Object.freeze({
    id,
    state: 'unavailable' as const,
    async start() {},
    async stop() {},
  });
}
