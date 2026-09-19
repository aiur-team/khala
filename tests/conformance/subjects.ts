// Conformance subjects built from the harness reference fakes, including the
// deliberately broken variants each oracle must reject. Contract literals come from
// the KHA-105/106 fixtures; no product policy default is chosen here.

import {
  type DeliveryLimits, type HarnessCapabilities, decodeDeliveryLimits, decodeHarnessCapabilities,
} from '@khala/contracts/delivery/index';
import exact from '../../packages/contracts/fixtures/delivery/exact-release.json';
import type { SourceVersion } from '../e2e/harness/evidence';
import { FAULTS } from '../e2e/harness/faults';
import { type OwnerControls, nextGeneration } from '../e2e/harness/owners';
import {
  type AdapterDefect, type ConnectorDefect, type ReferenceRoom, createFakeHarnessAdapter, createReferenceConnector,
  createReferenceRoom,
} from '../e2e/harness/reference';
import type { ScenarioHarness } from '../e2e/harness/scenario';
import type { DeliverySubjectFactory, HarnessSubjectFactory, SuiteEnvironment } from './suites';

function unwrap<T>(result: { ok: true; value: T } | { ok: false; field: string }, what: string): T {
  if (!result.ok) throw new Error(`${what} fixture does not decode (${result.field || 'root'})`);
  return result.value;
}

export const fixtureLimits: DeliveryLimits = unwrap(decodeDeliveryLimits(exact.limits), 'limits');

/**
 * The reference fake's own capability record. It is `experimental` with unknown
 * session scope: a fake cannot claim tested support for any real harness.
 */
export function fakeCapabilities(busy: HarnessCapabilities['busy']): HarnessCapabilities {
  return unwrap(decodeHarnessCapabilities({
    v: 2,
    harness: 'fake-reference',
    version: '0',
    adapterVersion: 'tests-e2e-harness',
    support: 'experimental',
    existingSession: 'unknown',
    immediateNotification: 'unknown',
    busy,
    receiptEvidence: ['harness_queued', 'context_consumed', 'outcome_unknown', 'failed'],
    reconcileByReleaseId: 'unknown',
    limits: exact.limits,
    evidenceRef: null,
  }), 'capabilities');
}

export const fakeSources: readonly SourceVersion[] = [{ component: 'fake-reference', version: '0' }];

/** Explicit per-owner controls; profiles deliberately collide to prove they do not merge owners. */
export function controlsFor(seed: string, harness = 'fake-reference'): OwnerControls {
  return {
    harness,
    sessionId: `thread-existing-${seed}`,
    generation: 0,
    policyVersion: 3,
    profile: { email: 'same@example.test', displayName: 'Sam' },
  };
}

export function fakeEnvironment(seeds: readonly string[]): SuiteEnvironment {
  return {
    mode: 'fake-contract',
    sources: fakeSources,
    owners: seeds.map(seed => ({ seed, controls: controlsFor(seed) })),
    limits: fixtureLimits,
  };
}

export function fakeHarnessSubject(capabilities: HarnessCapabilities, defect?: AdapterDefect): HarnessSubjectFactory {
  return async (scenario, owner) => {
    const adapter = createFakeHarnessAdapter({ scenario, owner, capabilities, ...(defect ? { defect } : {}) });
    return {
      mode: 'fake-contract',
      port: adapter,
      modelInputs: async () => adapter.modelInputs(),
      receipts: async () => adapter.streamed(),
      settle: async () => adapter.settle(),
      faults: FAULTS,
      close: () => adapter.close(),
    };
  };
}

export function referenceDeliverySubject(
  options: Readonly<{ capabilities: HarnessCapabilities; connectorDefect?: ConnectorDefect }>,
): DeliverySubjectFactory {
  // One room per scenario: the room-wide defects reach the other owners through it.
  const rooms = new WeakMap<ScenarioHarness, ReferenceRoom>();
  return async (scenario, owner) => {
    const room = rooms.get(scenario) ?? createReferenceRoom();
    rooms.set(scenario, room);
    const adapter = createFakeHarnessAdapter({ scenario, owner, capabilities: options.capabilities });
    const connector = createReferenceConnector({
      scenario,
      owner,
      adapter,
      limits: fixtureLimits,
      room,
      ...(options.connectorDefect ? { defect: options.connectorDefect } : {}),
    });
    return {
      mode: 'fake-contract',
      approvals: connector,
      deliver: (event, payload) => connector.deliver(event, payload),
      pending: async () => connector.pending(),
      undecryptable: async () => connector.undecryptable(),
      keysArrived: async () => connector.keysArrived(),
      restart: () => connector.restart(),
      revoke: async () => {
        // The session is re-armed at the next generation, whatever the connector does.
        connector.revoke();
        adapter.rearm(nextGeneration(owner).binding);
      },
      releases: async () => connector.releases(),
      modelInputs: async () => adapter.modelInputs(),
      releaseFacts: async releaseId => connector.releaseFacts(releaseId),
      faults: FAULTS,
      close: () => adapter.close(),
    };
  };
}
