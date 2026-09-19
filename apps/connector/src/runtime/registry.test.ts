import type { SessionBinding } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import type { ConnectorCapabilityContext } from './capabilities';
import { registerConnectorCapabilities, validateCapabilityRegistry } from './registry';

const context = {
  binding: {} as SessionBinding,
  ledger: { runtimeLedgerPort: true },
  dispatcher: {
    reconcilePending: async () => undefined,
    setEnabled: () => undefined,
    stop: async () => undefined,
  },
  clock: () => 0,
  protectedDependencies: {},
  prerequisiteChanged: () => undefined,
} satisfies ConnectorCapabilityContext;

describe('connector capability registry', () => {
  it('has one finite unavailable placeholder for every feature', () => {
    const capabilities = registerConnectorCapabilities(context);

    expect(capabilities.map(capability => [capability.id, capability.state])).toEqual([
      ['review', 'unavailable'],
      ['controls', 'unavailable'],
      ['recovery', 'unavailable'],
    ]);
  });

  it('rejects duplicate or missing registrations', () => {
    const capabilities = registerConnectorCapabilities(context);

    expect(() => validateCapabilityRegistry(capabilities.slice(0, 2))).toThrow(/missing capability: recovery/);
    expect(() => validateCapabilityRegistry([...capabilities, capabilities[0]!])).toThrow(/duplicate capability: review/);
  });
});
