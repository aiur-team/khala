import { describe, expect, it } from 'vitest';
import { EvidenceError, requireEvidence } from '../e2e/harness/evidence';
import { createFakeHarnessAdapter } from '../e2e/harness/reference';
import { createScenarioHarness } from '../e2e/harness/scenario';
import { fakeCapabilities, fakeEnvironment, fakeHarnessSubject, fixtureLimits, referenceDeliverySubject } from './subjects';
import { type ConformanceReport, acceptLiveHarness, authoredEvent, outcomeOf, releaseFor, runDeliveryConformance, runHarnessConformance } from './suites';

const failures = (report: ConformanceReport) => report.results.filter(result => result.outcome.status === 'fail');

describe('harness conformance', () => {
  it.each(['reject', 'queue'] as const)('the reference adapter passes with busy=%s', async busy => {
    const report = await runHarnessConformance(fakeHarnessSubject(fakeCapabilities(busy)), fakeCapabilities(busy), fakeEnvironment(['b', 'c', 'a']));
    expect(failures(report)).toEqual([]);
    expect(outcomeOf(report, 'fault.session_busy').status).toBe('pass');
  });

  it('reports unclaimed receipt kinds as explicit skips, never as passes', async () => {
    const report = await runHarnessConformance(fakeHarnessSubject(fakeCapabilities('reject')), fakeCapabilities('reject'), fakeEnvironment(['b', 'c']));
    for (const kind of ['transport_written', 'completed', 'cancelled'] as const) {
      expect(outcomeOf(report, `receipt.${kind}`)).toEqual({ status: 'skip', reason: `capabilities do not claim ${kind} receipts` });
    }
  });

  it('skips fault checks a subject cannot inject, with the reason', async () => {
    const capabilities = fakeCapabilities('reject');
    const limited = fakeHarnessSubject(capabilities);
    const report = await runHarnessConformance(async (scenario, owner) => ({ ...(await limited(scenario, owner)), faults: [] }),
      capabilities, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'fault.session_exit')).toEqual({ status: 'skip', reason: 'subject cannot inject session_exit' });
  });

  it('fails an adapter that claims consumption without model input', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities, 'false_consumption'), capabilities, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'receipt.consumption_is_observed')).toMatchObject({ status: 'fail' });
  });

  it('refuses a registered capability record that differs from inspect()', async () => {
    const report = await runHarnessConformance(fakeHarnessSubject(fakeCapabilities('queue')), fakeCapabilities('reject'), fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'capabilities.declared')).toMatchObject({ status: 'fail' });
  });
});

describe('delivery conformance', () => {
  it('the reference connector passes every check', async () => {
    const report = await runDeliveryConformance(referenceDeliverySubject({ capabilities: fakeCapabilities('reject') }), fakeEnvironment(['a', 'b', 'c']));
    expect(failures(report)).toEqual([]);
    expect(report.results.every(result => result.outcome.status === 'pass')).toBe(true);
  });

  it('fails a connector that resubmits after an unknown outcome', async () => {
    const report = await runDeliveryConformance(
      referenceDeliverySubject({ capabilities: fakeCapabilities('reject'), connectorDefect: 'repeat_submit_after_unknown' }),
      fakeEnvironment(['a', 'b', 'c']),
    );
    expect(outcomeOf(report, 'unknown.no_repeat_submit')).toMatchObject({ status: 'fail' });
  });
});

describe('fake evidence cannot satisfy live acceptance (AE2)', () => {
  it('refuses a passing fake-contract report as live harness acceptance', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, fakeEnvironment(['b', 'c']));
    expect(failures(report)).toEqual([]);
    expect(() => acceptLiveHarness(report, ['receipt.consumption_is_observed'])).toThrow(/fake-contract evidence/);
  });

  it('refuses a live report whose required check was skipped', () => {
    const report = { suite: 'x', mode: 'live-harness' as const, results: [{ check: 'fault.session_exit', outcome: { status: 'skip' as const, reason: 'n/a' } }] };
    expect(() => acceptLiveHarness(report, ['fault.session_exit'])).toThrow(/did not run fault.session_exit: skip/);
  });

  it('a fake context_consumed receipt is not live harness evidence', async () => {
    const scenario = await createScenarioHarness({ runId: 'ae2', mode: 'fake-contract', owners: fakeEnvironment(['b', 'c']).owners, sources: [] });
    const [b, c] = scenario.owners;
    const adapter = createFakeHarnessAdapter({ scenario, owner: b!, capabilities: fakeCapabilities('reject') });
    const event = authoredEvent(c!, 'room-1', 'consumed');
    const receipt = await adapter.submit({ job: releaseFor(b!, [event.ref], event.payload, 'release-ae2', fixtureLimits), payload: event.payload });
    expect(receipt.kind).toBe('context_consumed');
    expect(requireEvidence(scenario.evidence(), { kind: 'receipt.context_consumed', modes: ['fake-contract'] })).toHaveLength(1);
    expect(() => requireEvidence(scenario.evidence(), { kind: 'receipt.context_consumed', modes: ['live-harness'] }))
      .toThrow(new EvidenceError('receipt.context_consumed evidence exists only as fake-contract; live-harness is required'));
    await scenario.close();
  });
});
