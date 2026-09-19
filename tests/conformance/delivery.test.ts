import { describe, expect, it } from 'vitest';
import { EvidenceError, requireEvidence } from '../e2e/harness/evidence';
import { FAULTS } from '../e2e/harness/faults';
import { type AdapterDefect, type ConnectorDefect, createFakeHarnessAdapter } from '../e2e/harness/reference';
import { type ScenarioDriver, createScenarioHarness } from '../e2e/harness/scenario';
import { claudeCapabilities, claudeEnvironment, claudeHarnessSubject } from './claude-subject';
import { fakeCapabilities, fakeEnvironment, fakeHarnessSubject, fixtureLimits, referenceDeliverySubject } from './subjects';
import {
  type ConformanceReport, type DeliverySubjectFactory, type HarnessSubjectFactory, acceptLiveHarness, authoredEvent, outcomeOf, releaseFor,
  runDeliveryConformance, runHarnessConformance,
} from './suites';

const failures = (report: ConformanceReport) => report.results.filter(result => result.outcome.status === 'fail');
const liveOn = { enabled: true, disposableEnv: 'conformance-test' } as const;

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

  // Each deliberately broken adapter must fail the oracle that names its bug.
  it.each<[AdapterDefect, 'reject' | 'queue', string, RegExp]>([
    ['false_consumption', 'reject', 'receipt.consumption_is_observed', /context_consumed for .* without a model-facing input/],
    ['false_consumption', 'reject', 'fault.session_exit', /exited session reported context_consumed/],
    ['replacement_session', 'reject', 'session.identity_preserved', /outside the bound existing session/],
    ['skip_digest_check', 'reject', 'payload.exact_digest', /does not match the release digest was accepted/],
    ['notify_writes_content', 'reject', 'notify.no_pending_hint', /notification put content into model context/],
    ['unknown_reported_consumed', 'reject', 'fault.disconnect_after_write', /reported as a definite outcome/],
    ['retry_unconfirmed_write', 'reject', 'fault.disconnect_after_write', /received release .* 2 times/],
    ['write_after_exit', 'reject', 'fault.session_exit', /reached a model after its session exited/],
    ['busy_leaks_write', 'reject', 'fault.session_busy', /rejected release reached the model/],
    ['busy_leaks_write', 'queue', 'fault.session_busy', /busy session received the release before its turn ended/],
    ['busy_drops_queue', 'queue', 'fault.session_busy', /reached the model 0 times once the session was idle/],
    ['binding_id_only', 'reject', 'binding.revoked_blocks', /another binding generation reached the session/],
    ['acknowledges_foreign', 'reject', 'binding.revoked_blocks', /another binding generation reported harness_queued/],
    ['cross_owner_release', 'reject', 'binding.owner_specific', /c's release reached b's session/],
    ['acknowledges_foreign', 'reject', 'binding.owner_specific', /b's adapter reported acceptance of c's release/],
    ['misattributed_receipt', 'reject', 'session.identity_preserved', /context_consumed receipt names a different binding or generation/],
    ['consumed_without_input', 'reject', 'session.identity_preserved', /consumption reported but no model input observed/],
    ['rewrites_payload', 'reject', 'payload.exact_digest', /model received bytes with another digest/],
    ['writes_rejected_payload', 'reject', 'payload.exact_digest', /mismatched payload reached the model/],
    ['reconcile_wrong_release', 'reject', 'fault.disconnect_after_write', /reconcile answered for another release/],
    ['busy_ignores_route', 'reject', 'fault.session_busy', /busy reject reported harness_queued/],
    ['always_fail', 'reject', 'session.identity_preserved', /healthy session refused a valid release/],
    ['always_fail', 'reject', 'payload.exact_digest', /healthy session refused a valid release/],
    ['always_fail', 'reject', 'receipt.consumption_is_observed', /every valid submission failed/],
  ])('fails an adapter with %s (busy=%s) on %s', async (defect, busy, check, reason) => {
    const capabilities = fakeCapabilities(busy);
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities, defect), capabilities, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, check)).toEqual({ status: 'fail', reason: expect.stringMatching(reason) });
  });

  it('fails an adapter that emits receipt kinds its capabilities do not claim', async () => {
    const claimed = fakeCapabilities('reject');
    const unclaimed = { ...claimed, receiptEvidence: claimed.receiptEvidence.filter(kind => kind !== 'context_consumed') };
    const report = await runHarnessConformance(fakeHarnessSubject(unclaimed), unclaimed, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'receipt.consumption_is_observed')).toEqual({
      status: 'fail', reason: 'adapter emitted context_consumed receipts its capabilities do not claim',
    });
  });

  it('fails an unsupported adapter whose refusal is not harness_unavailable', async () => {
    const capabilities = claudeCapabilities();
    const honest = claudeHarnessSubject();
    const weakened: HarnessSubjectFactory = async (scenario, owner) => {
      const subject = await honest(scenario, owner);
      return {
        ...subject,
        port: {
          ...subject.port,
          submit: async ({ job }) => ({
            v: 1,
            receiptId: `receipt-${job.releaseId}` as never,
            releaseId: job.releaseId,
            bindingId: job.binding.bindingId,
            generation: job.binding.generation,
            kind: 'failed',
            observedAt: '2026-09-18T00:00:00.000Z',
            source: 'harness',
            evidenceRef: null,
            errorCode: 'session_unavailable',
          }),
        },
      };
    };
    const report = await runHarnessConformance(weakened, capabilities, claudeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'support.fail_closed')).toEqual({
      status: 'fail',
      reason: 'an unsupported adapter returned failed (session_unavailable), expected failed (harness_unavailable)',
    });
  });

  it('fails an unsupported adapter that reports refusal after model delivery', async () => {
    const capabilities = claudeCapabilities();
    const honest = claudeHarnessSubject();
    const leaks: HarnessSubjectFactory = async (scenario, owner) => {
      const subject = await honest(scenario, owner);
      let submitted: Parameters<typeof subject.port.submit>[0] | undefined;
      return {
        ...subject,
        port: {
          ...subject.port,
          submit: async input => {
            submitted = input;
            return subject.port.submit(input);
          },
        },
        modelInputs: async () => submitted ? [{
          releaseId: submitted.job.releaseId,
          bindingId: submitted.job.binding.bindingId,
          sessionId: submitted.job.binding.sessionId,
          generation: submitted.job.binding.generation,
          payloadDigest: submitted.job.payloadDigest,
        }] : [],
      };
    };
    const report = await runHarnessConformance(leaks, capabilities, claudeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'support.fail_closed')).toEqual({
      status: 'fail', reason: 'an unsupported adapter delivered content to the model',
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

  it('fails a check whose subject claims a fault it never fires', async () => {
    const capabilities = fakeCapabilities('reject');
    const honest = fakeHarnessSubject(capabilities);
    // Reports the right receipt without ever reaching the harness.accept boundary.
    const pretends: HarnessSubjectFactory = async (scenario, owner) => {
      const subject = await honest(scenario, owner);
      return {
        ...subject,
        port: {
          ...subject.port,
          submit: async ({ job }) => ({
            v: 1, receiptId: `receipt-${job.releaseId}` as never, releaseId: job.releaseId, bindingId: job.binding.bindingId,
            generation: job.binding.generation, kind: 'failed', observedAt: '2026-09-18T00:00:00.000Z', source: 'harness',
            evidenceRef: null, errorCode: 'session_unavailable',
          }),
        },
      };
    };
    const report = await runHarnessConformance(pretends, capabilities, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'fault.session_exit')).toEqual({
      status: 'fail', reason: 'fault session_exit for owner-b never reached its boundary',
    });
  });

  it('compares capability records by value, not key order', async () => {
    const capabilities = fakeCapabilities('reject');
    const reordered = Object.fromEntries(Object.entries(capabilities).reverse()) as typeof capabilities;
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), reordered, fakeEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'capabilities.declared')).toEqual({ status: 'pass' });
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

  // Each deliberately broken connector must fail the oracle that names its bug.
  it.each<[ConnectorDefect, string, RegExp]>([
    ['leak_pending', 'pending.not_in_model_context', /model saw pending E7 before approval/],
    ['drops_events', 'pending.not_in_model_context', /b has no pending copy of E7/],
    ['cross_owner_release', 'authority.cross_owner_release', /A's authority on B's connector returned ok/],
    ['cross_owner_silent', 'authority.cross_owner_release', /A's approval released E7 into B's agent/],
    ['refuses_owner', 'authority.owner_specific_release', /B's own approval failed: forbidden/],
    ['double_submit', 'authority.owner_specific_release', /E7 did not reach B's session exactly once/],
    ['auto_bumps_version', 'policy.auto_refused', /a review policy at the original version was rejected/],
    ['revocation_leaks', 'binding.revoked_blocks', /approval for a revoked binding reached the model/],
    ['reports_unknown_as_ok', 'unknown.no_repeat_submit', /unconfirmed write reported ok/],
    ['reports_unknown_as_ok', 'reordered_receipt.facts_not_progress', /unconfirmed write reported ok/],
    ['forgets_intent', 'crash_after_intent.reconciled', /expected one release in the ledger, saw 0/],
    ['release_room_wide', 'authority.owner_specific_release', /B's approval released C's copy/],
    ['dismiss_room_wide', 'authority.owner_specific_release', /B's approval removed C's pending copy/],
    ['accepts_auto', 'policy.auto_refused', /auto mode was effective/],
    ['ignores_revocation', 'binding.revoked_blocks', /approval for a revoked binding returned ok/],
    ['repeat_submit_after_unknown', 'unknown.no_repeat_submit', /model received E7 2 times/],
    ['resubmit_intent_on_restart', 'crash_after_intent.reconciled', /restart submitted a release whose outcome is unknown/],
    ['no_dedupe', 'duplicate_event.single_pending', /redelivered event became two pending items/],
    ['double_submit', 'duplicate_event.single_pending', /redelivered event reached the model 2 times/],
    ['drop_undecryptable', 'keys_delayed.visible_not_releasable', /event without keys disappeared/],
    ['release_undecryptable', 'keys_delayed.visible_not_releasable', /undecryptable event was released/],
    ['keys_lost', 'keys_delayed.visible_not_releasable', /did not become pending once keys arrived/],
    ['last_receipt_wins', 'reordered_receipt.facts_not_progress', /later receipt erased an earlier fact/],
  ])('fails a connector with %s on %s', async (connectorDefect, check, reason) => {
    const report = await runDeliveryConformance(
      referenceDeliverySubject({ capabilities: fakeCapabilities('reject'), connectorDefect }),
      fakeEnvironment(['a', 'b', 'c']),
    );
    expect(outcomeOf(report, check)).toEqual({ status: 'fail', reason: expect.stringMatching(reason) });
  });

  it('fails a connector whose ledger settles a crashed release without proof', async () => {
    const honest = referenceDeliverySubject({ capabilities: fakeCapabilities('reject') });
    const settles: DeliverySubjectFactory = async (scenario, owner) => {
      const subject = await honest(scenario, owner);
      return { ...subject, releases: async () => (await subject.releases()).map(entry => ({ ...entry, state: 'submitted' as const })) };
    };
    const report = await runDeliveryConformance(settles, fakeEnvironment(['a', 'b', 'c']));
    expect(outcomeOf(report, 'crash_after_intent.reconciled')).toEqual({
      status: 'fail', reason: 'after restart the crashed release is submitted, not unknown or reconciling',
    });
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
  const stubLiveDriver = (): ScenarioDriver => ({
    name: 'stub-live', mode: 'live-harness', source: { component: 'codex', version: '0.154.0' }, faults: FAULTS, close: async () => undefined,
  });
  const liveLabel = { ...fakeEnvironment(['b', 'c']), mode: 'live-harness' as const, sources: [stubLiveDriver().source], drivers: () => [stubLiveDriver()] };

  it('refuses a passing fake-contract report as live harness acceptance', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, fakeEnvironment(['b', 'c']));
    expect(failures(report)).toEqual([]);
    expect(() => acceptLiveHarness(report, { environment: liveOn })).toThrow(/fake-contract evidence/);
  });

  it('a fake adapter run under a live-harness label fails every check', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, liveLabel);
    for (const result of report.results) {
      expect(result.outcome).toEqual({ status: 'fail', reason: 'subject produces fake-contract evidence in a live-harness suite' });
    }
    expect(() => acceptLiveHarness(report, { environment: liveOn })).toThrow(/failed/);
  });

  it('a fake adapter that also claims live-harness mode still fails: it cannot write live evidence', async () => {
    const capabilities = fakeCapabilities('reject');
    const honest = fakeHarnessSubject(capabilities);
    const relabelled: HarnessSubjectFactory = async (scenario, owner) => ({ ...(await honest(scenario, owner)), mode: 'live-harness' });
    const report = await runHarnessConformance(relabelled, capabilities, liveLabel);
    expect(outcomeOf(report, 'capabilities.declared')).toEqual({
      status: 'fail', reason: 'passed without any live evidence from a registered driver',
    });
    expect(outcomeOf(report, 'session.identity_preserved')).toEqual({
      status: 'fail', reason: "threw Error: a fault checkpoint in a live-harness scenario must go through a registered driver's handle",
    });
    expect(report.results.filter(result => result.outcome.status === 'pass')).toEqual([]);
    expect(() => acceptLiveHarness(report, { environment: liveOn })).toThrow(/failed/);
  });

  it('refuses a live suite without a registered live driver', async () => {
    const capabilities = fakeCapabilities('reject');
    const environment = { ...fakeEnvironment(['b', 'c']), mode: 'live-harness' as const, sources: [{ component: 'codex', version: '0.154.0' }] };
    await expect(runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, environment))
      .rejects.toThrow(/needs at least one registered live-harness driver/);
  });

  it('refuses a hand-built report, whatever it claims', () => {
    const report: ConformanceReport = {
      suite: 'x', mode: 'live-harness', manifests: [], results: [{ check: 'receipt.consumption_is_observed', outcome: { status: 'pass' } }],
    };
    expect(() => acceptLiveHarness(report, { environment: liveOn })).toThrow(/only a report produced by a conformance run/);
  });

  it('refuses live acceptance outside an opted-in environment, or with no required checks', async () => {
    const capabilities = fakeCapabilities('reject');
    const report = await runHarnessConformance(fakeHarnessSubject(capabilities), capabilities, liveLabel);
    expect(() => acceptLiveHarness(report, { environment: { enabled: false, reason: 'KHALA_E2E_LIVE is not 1' } }))
      .toThrow(/needs an opted-in live environment: KHALA_E2E_LIVE is not 1/);
    expect(() => acceptLiveHarness(report, { environment: liveOn, required: [] })).toThrow(/at least one required check/);
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
