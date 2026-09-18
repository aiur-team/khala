import { describe, expect, it } from 'vitest';
import { ownerAuthority } from '../e2e/harness/owners';
import { createFakeHarnessAdapter, createReferenceConnector } from '../e2e/harness/reference';
import { createScenarioHarness } from '../e2e/harness/scenario';
import { fakeCapabilities, fakeEnvironment, fakeHarnessSubject, fixtureLimits, referenceDeliverySubject } from './subjects';
import { outcomeOf, runDeliveryConformance, runHarnessConformance } from './suites';

describe("owner A's approval cannot release into B's agent (AE1)", () => {
  it('passes the authority checks for the reference connector', async () => {
    const report = await runDeliveryConformance(referenceDeliverySubject({ capabilities: fakeCapabilities('reject') }), fakeEnvironment(['a', 'b', 'c']));
    expect(outcomeOf(report, 'authority.cross_owner_release')).toEqual({ status: 'pass' });
    expect(outcomeOf(report, 'authority.owner_specific_release')).toEqual({ status: 'pass' });
  });

  it('fails a connector that accepts another owner’s authority', async () => {
    const report = await runDeliveryConformance(
      referenceDeliverySubject({ capabilities: fakeCapabilities('reject'), connectorDefect: 'cross_owner_release' }),
      fakeEnvironment(['a', 'b', 'c']),
    );
    expect(outcomeOf(report, 'authority.cross_owner_release')).toMatchObject({ status: 'fail' });
  });

  it('fails an adapter that writes another owner’s release into its session', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities, 'cross_owner_release'), capabilities, fakeEnvironment(['c', 'b', 'a']));
    expect(outcomeOf(report, 'binding.owner_specific')).toMatchObject({ status: 'fail' });
  });
});

describe('adding C does not alter B', () => {
  const policySet = (bindingId: string, expectedPolicyVersion: number) => ({
    v: 1 as const,
    commandId: `policy-${bindingId}` as never,
    roomId: 'room-1' as never,
    bindingId: bindingId as never,
    peerParticipantId: 'agent-a' as never,
    expectedPolicyVersion,
    expectedBindingGeneration: 0,
    mode: 'review' as const,
    paused: true,
    issuedAt: '2026-09-18T00:00:00Z',
  });

  it("gives B the same fixture and policy with or without C, and C's policy change leaves B untouched", async () => {
    const pair = await createScenarioHarness({ runId: 'pair', mode: 'fake-contract', owners: fakeEnvironment(['a', 'b']).owners, sources: [] });
    const trio = await createScenarioHarness({ runId: 'trio', mode: 'fake-contract', owners: fakeEnvironment(['a', 'b', 'c']).owners, sources: [] });
    expect(trio.owner('b')).toEqual(pair.owner('b'));

    const connectors = trio.owners.map(owner => createReferenceConnector({
      scenario: trio,
      owner,
      adapter: createFakeHarnessAdapter({ scenario: trio, owner, capabilities: fakeCapabilities('reject') }),
      limits: fixtureLimits,
    }));
    const [, b, c] = connectors;
    const authority = (seed: string) => ownerAuthority(trio.owner(seed), { authorizationId: `authz-${seed}`, authenticatedAt: '2026-09-18T00:00:00Z' });

    const ack = await c!.setPolicy(authority('c'), policySet(trio.owner('c').binding.bindingId, 3));
    expect(ack.connectorState).toBe('effective');
    expect(c!.policyVersion()).toBe(4);
    expect(b!.policyVersion()).toBe(3);

    const forged = await b!.setPolicy(authority('c'), policySet(trio.owner('b').binding.bindingId, 3));
    expect(forged).toMatchObject({ connectorState: 'rejected', errorCode: 'forbidden' });
    expect(b!.policyVersion()).toBe(3);
    await Promise.all([pair.close(), trio.close()]);
  });
});
