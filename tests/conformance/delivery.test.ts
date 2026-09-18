import { describe, expect, it } from 'vitest';
import { EvidenceError, requireEvidence } from '../e2e/harness/evidence';
import { FAULTS } from '../e2e/harness/faults';
import { createFakeHarnessAdapter } from '../e2e/harness/reference';
import { type ScenarioDriver, createScenarioHarness } from '../e2e/harness/scenario';
import { fakeCapabilities, fakeEnvironment, fakeHarnessSubject, fixtureLimits, referenceDeliverySubject } from './subjects';
import {
  type ConformanceReport, type DeliverySubjectFactory, type HarnessSubjectFactory, acceptLiveHarness, authoredEvent, outcomeOf, releaseFor,
  runDeliveryConformance, runHarnessConformance,
} from './suites';

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

  it('fails an adapter that emits receipt kinds its capabilities do not claim', async () => {
    const claimed = fakeCapabilities('reject');
    const unclaimed = { ...claimed, receiptEvidence: claimed.receiptEvidence.filter(kind => kind !== 'context_consumed') };
    const report = await runHarnessConformance(fakeHarnessSubject(unclaimed), unclaimed, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'receipt.consumption_is_observed')).toEqual({
      status: 'fail', reason: 'adapter emitted context_consumed receipts its capabilities do not claim',
    });
  });

  it('fails a queue adapter that reaches the busy boundary but writes straight through', async () => {
    const capabilities = fakeCapabilities('queue');
    const honest = fakeHarnessSubject(capabilities);
    const ignoresBusy: HarnessSubjectFactory = async (scenario, owner) => {
      const subject = await honest(scenario, owner);
      return {
        ...subject,
        port: {
          ...subject.port,
          submit: input => {
            if (scenario.faults.checkpoint('harness.accept', owner.ownerId, input.job.releaseId) === 'session_busy') {
              scenario.faults.clear('session_busy', owner.ownerId);
            }
            return subject.port.submit(input);
          },
        },
      };
    };
    const report = await runHarnessConformance(ignoresBusy, capabilities, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'fault.session_busy')).toEqual({ status: 'fail', reason: 'busy queue reported context_consumed' });
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

  it('fails the receipt ordering oracle when a connector keeps no receipt facts', async () => {
    const honest = referenceDeliverySubject({ capabilities: fakeCapabilities('reject') });
    const forgetful: DeliverySubjectFactory = async (scenario, owner) => ({ ...(await honest(scenario, owner)), releaseFacts: async () => [] });
    const report = await runDeliveryConformance(forgetful, fakeEnvironment(['a', 'b', 'c']));
    expect(outcomeOf(report, 'reordered_receipt.facts_not_progress')).toEqual({
      status: 'fail', reason: 'needs two distinct receipt facts to reorder, saw none',
    });
  });
});

describe('fake evidence cannot satisfy live acceptance (AE2)', () => {
  it('refuses a passing fake-contract report as live harness acceptance', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, fakeEnvironment(['b', 'c']));
    expect(failures(report)).toEqual([]);
    expect(() => acceptLiveHarness(report, ['receipt.consumption_is_observed'])).toThrow(/fake-contract evidence/);
  });

  it('a fake adapter run under a live-harness label fails every check', async () => {
    const capabilities = fakeCapabilities('reject');
    const liveDriver: ScenarioDriver = {
      name: 'stub-live', mode: 'live-harness', source: { component: 'codex', version: '0.154.0' }, faults: FAULTS, close: async () => undefined,
    };
    const environment = { ...fakeEnvironment(['b', 'c']), mode: 'live-harness' as const, sources: [liveDriver.source], drivers: () => [liveDriver] };
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, environment);
    for (const result of report.results) {
      expect(result.outcome).toEqual({ status: 'fail', reason: 'subject produces fake-contract evidence in a live-harness suite' });
    }
    expect(() => acceptLiveHarness(report, ['receipt.consumption_is_observed'])).toThrow(/failed/);
  });

  it('refuses a live suite without a registered live driver', async () => {
    const capabilities = fakeCapabilities('reject');
    const environment = { ...fakeEnvironment(['b', 'c']), mode: 'live-harness' as const, sources: [{ component: 'codex', version: '0.154.0' }] };
    await expect(runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, environment))
      .rejects.toThrow(/needs at least one registered live-harness driver/);
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
