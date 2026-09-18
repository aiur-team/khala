import { describe, expect, it } from 'vitest';
import { authoredEvent, releaseFor } from '../../conformance/suites';
import { controlsFor, fakeCapabilities, fixtureLimits } from '../../conformance/subjects';
import { FAULTS, FAULT_SPECS, type Fault, InjectedCrash, InjectedDisconnect } from './faults';
import { createFakeHarnessAdapter, createReferenceConnector } from './reference';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from './scenario';

const scenario = () => createScenarioHarness({
  runId: 'faults',
  mode: 'fake-contract',
  owners: ['a', 'b'].map(seed => ({ seed, controls: controlsFor(seed) })),
  sources: [],
});

/** Drives the reference stack through the boundary of `fault` for owner B. */
async function exercise(harness: ScenarioHarness, fault: Fault): Promise<unknown> {
  const a = harness.owner('a');
  const b = harness.owner('b');
  const adapter = createFakeHarnessAdapter({ scenario: harness, owner: b, capabilities: fakeCapabilities('reject') });
  const connector = createReferenceConnector({ scenario: harness, owner: b, adapter, limits: fixtureLimits });
  const event = authoredEvent(a, 'room-1', fault);
  const job = releaseFor(b, [event.ref], event.payload, `release-${fault}`, fixtureLimits);
  try {
    switch (FAULT_SPECS[fault].boundary) {
      case 'transport.before_write':
      case 'transport.after_write':
      case 'harness.accept':
        return await adapter.submit({ job, payload: event.payload });
      case 'transport.deliver_event':
      case 'crypto.decrypt':
      case 'connector.after_pending':
        return await connector.deliver(event.ref, event.payload);
      case 'connector.after_intent': {
        await connector.deliver(event.ref, event.payload);
        const authority = { ownerId: b.ownerId, issuer: 'x', subject: 'x', authenticatedAt: 'x', authorizationId: 'z' as never };
        return await connector.approve(authority, {
          v: 1, commandId: 'c1' as never, roomId: event.ref.roomId, bindingId: b.binding.bindingId,
          expectedPolicyVersion: 3, expectedBindingGeneration: 0, selection: [event.ref], issuedAt: '2026-09-18T00:00:00Z',
        });
      }
      case 'transport.deliver_receipts': {
        const receipt = await adapter.submit({ job, payload: event.payload });
        return connector.ingestReceipts([receipt]);
      }
    }
  } catch (error) {
    return error;
  }
}

describe('fault runner', () => {
  it('documents a boundary and an oracle for every fault', () => {
    for (const fault of FAULTS) expect(FAULT_SPECS[fault].oracle.length).toBeGreaterThan(10);
  });

  it.each(FAULTS)('%s fires at its named boundary and records evidence', async fault => {
    const harness = await scenario();
    await harness.inject(fault, harness.owner('b').ownerId);
    const outcome = await exercise(harness, fault);
    expect(harness.faults.fired()).toEqual([expect.objectContaining({ fault, ownerId: 'owner-b' })]);
    expect(harness.evidence().filter(record => record.kind === `fault.${fault}`)).toHaveLength(1);
    const effect = FAULT_SPECS[fault].effect;
    if (effect === 'throw_disconnect') expect(outcome).toBeInstanceOf(InjectedDisconnect);
    if (effect === 'throw_crash') expect(outcome).toBeInstanceOf(InjectedCrash);
    if (FAULT_SPECS[fault].held) harness.faults.clear(fault, 'owner-b');
    assertCleanClose(await harness.close());
  });

  it('does not fire for another owner', async () => {
    const harness = await scenario();
    await harness.inject('session_exit', harness.owner('a').ownerId);
    const receipt = await exercise(harness, 'session_exit');
    expect(receipt).toMatchObject({ kind: 'context_consumed' });
    expect(harness.faults.fired()).toEqual([]);
    await harness.close();
  });

  it('fails its own oracle when an injected fault never reaches a boundary', async () => {
    const harness = await scenario();
    await harness.inject('crash_after_intent', harness.owner('b').ownerId);
    const report = await harness.close();
    expect(report.unfiredFaults).toEqual([{ fault: 'crash_after_intent', ownerId: 'owner-b' }]);
    expect(() => assertCleanClose(report)).toThrow(/crash_after_intent for owner-b never reached its boundary/);
  });

  it('keeps a held fault firing until cleared, and a one-shot fault firing once', async () => {
    const harness = await scenario();
    harness.faults.arm('session_busy', 'owner-b');
    harness.faults.arm('duplicate_event', 'owner-b');
    for (let i = 0; i < 2; i += 1) {
      expect(harness.faults.checkpoint('harness.accept', 'owner-b', `op-${i}`)).toBe('session_busy');
      expect(harness.faults.checkpoint('transport.deliver_event', 'owner-b', `op-${i}`)).toBe(i === 0 ? 'duplicate_event' : null);
    }
    harness.faults.clear('session_busy', 'owner-b');
    expect(harness.faults.checkpoint('harness.accept', 'owner-b', 'op-3')).toBeNull();
    expect(() => harness.faults.clear('keys_delayed', 'owner-b')).toThrow(/not armed/);
    await harness.close();
  });

  it('delays keys without losing the event, then releases it once keys arrive', async () => {
    const harness = await scenario();
    const b = harness.owner('b');
    const adapter = createFakeHarnessAdapter({ scenario: harness, owner: b, capabilities: fakeCapabilities('queue') });
    const connector = createReferenceConnector({ scenario: harness, owner: b, adapter, limits: fixtureLimits });
    await harness.inject('keys_delayed', b.ownerId);
    const event = authoredEvent(harness.owner('a'), 'room-1', 'keys');
    await connector.deliver(event.ref, event.payload);
    expect(connector.undecryptable()).toEqual([event.ref]);
    expect(connector.pending()).toEqual([]);
    connector.keysArrived();
    expect(connector.pending()).toEqual([event.ref]);
    assertCleanClose(await harness.close());
  });

  it('queues a busy session’s release and gives it to the model once when idle', async () => {
    const harness = await scenario();
    const b = harness.owner('b');
    const adapter = createFakeHarnessAdapter({ scenario: harness, owner: b, capabilities: fakeCapabilities('queue') });
    await harness.inject('session_busy', b.ownerId);
    const event = authoredEvent(harness.owner('a'), 'room-1', 'busy');
    const job = releaseFor(b, [event.ref], event.payload, 'release-busy', fixtureLimits);
    expect(await adapter.submit({ job, payload: event.payload })).toMatchObject({ kind: 'harness_queued' });
    expect(adapter.modelInputs()).toEqual([]);
    adapter.idle();
    expect(adapter.modelInputs().map(input => input.releaseId)).toEqual(['release-busy']);
    expect(await adapter.reconcile(job)).toMatchObject({ kind: 'context_consumed' });
    assertCleanClose(await harness.close());
  });
});
