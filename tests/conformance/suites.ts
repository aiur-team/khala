// Neutral conformance suites. Each check runs in its own fresh scenario and returns
// pass, fail with a reason, or skip with a reason. A skipped check is never counted
// as a pass, and unsupported capabilities are skipped rather than synthesized.

import {
  type ApprovalCommand, type ApprovalPort, type DeliveryLimits, type EventRef, type HarnessCapabilities, type HarnessPort,
  type ReceiptKind, type ReleasedJob, RECEIPT_KINDS, type SessionBinding, decodeApprovalCommand,
  releaseFromApproval, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import type { EvidenceMode, SourceVersion } from '../e2e/harness/evidence';
import { type Fault, InjectedDisconnect } from '../e2e/harness/faults';
import { type OwnerControls, type OwnerFixture, ownerAuthority } from '../e2e/harness/owners';
import { type ModelInput, sha256 } from '../e2e/harness/reference';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../e2e/harness/scenario';

export type CheckOutcome =
  | Readonly<{ status: 'pass' }>
  | Readonly<{ status: 'fail'; reason: string }>
  | Readonly<{ status: 'skip'; reason: string }>;

export type CheckResult = Readonly<{ check: string; outcome: CheckOutcome }>;

export type ConformanceReport = Readonly<{
  suite: string;
  mode: EvidenceMode;
  results: readonly CheckResult[];
}>;

class CheckFailed extends Error {}
class CheckSkipped extends Error {}

export function ensure(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new CheckFailed(reason);
}

export function skip(reason: string): never {
  throw new CheckSkipped(reason);
}

/** Scenario settings shared by every check; each check still gets a fresh scenario. */
export type SuiteEnvironment = Readonly<{
  mode: EvidenceMode;
  sources: readonly SourceVersion[];
  /** Owners in the scenario. The first owner is the subject; the others are bystanders. */
  owners: readonly Readonly<{ seed: string; controls: OwnerControls }>[];
  limits: DeliveryLimits;
}>;

type Check<Subject> = Readonly<{
  name: string;
  run: (context: Readonly<{ scenario: ScenarioHarness; subjects: ReadonlyMap<string, Subject> }>) => Promise<void>;
}>;

async function runChecks<Subject extends { close(): Promise<void> }>(
  suite: string,
  environment: SuiteEnvironment,
  checks: readonly Check<Subject>[],
  factory: (scenario: ScenarioHarness, owner: OwnerFixture) => Promise<Subject>,
): Promise<ConformanceReport> {
  const results: CheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    const scenario = await createScenarioHarness({
      runId: `${suite}-${index}`,
      mode: environment.mode,
      owners: environment.owners,
      sources: environment.sources,
    });
    let outcome: CheckOutcome;
    try {
      const subjects = new Map<string, Subject>();
      for (const owner of scenario.owners) {
        const subject = await factory(scenario, owner);
        subjects.set(owner.ownerId, subject);
        scenario.defer(`subject:${owner.seed}`, owner.ownerId, () => subject.close());
      }
      await check.run({ scenario, subjects });
      outcome = { status: 'pass' };
    } catch (error) {
      if (error instanceof CheckSkipped) outcome = { status: 'skip', reason: error.message };
      else if (error instanceof CheckFailed) outcome = { status: 'fail', reason: error.message };
      else outcome = { status: 'fail', reason: `threw ${error instanceof Error ? `${error.name}: ${error.message}` : 'non-error'}` };
    }
    const report = await scenario.close();
    if (outcome.status !== 'fail') {
      try {
        assertCleanClose(report);
      } catch (error) {
        outcome = { status: 'fail', reason: (error as Error).message };
      }
    }
    results.push({ check: check.name, outcome });
  }
  return Object.freeze({ suite, mode: environment.mode, results: Object.freeze(results) });
}

export function outcomeOf(report: ConformanceReport, check: string): CheckOutcome {
  const result = report.results.find(entry => entry.check === check);
  if (!result) throw new Error(`${report.suite} has no check ${check}`);
  return result.outcome;
}

/**
 * Accepts a report as live harness evidence. A fake report, a failed check or a
 * skipped required check is refused, whatever its receipts claimed.
 */
export function acceptLiveHarness(report: ConformanceReport, required: readonly string[]): void {
  if (report.mode !== 'live-harness') {
    throw new Error(`${report.suite} is ${report.mode} evidence; live harness acceptance needs live-harness`);
  }
  const failed = report.results.filter(entry => entry.outcome.status === 'fail');
  if (failed.length > 0) throw new Error(`${report.suite} failed: ${failed.map(entry => entry.check).join(', ')}`);
  for (const check of required) {
    const outcome = outcomeOf(report, check);
    if (outcome.status !== 'pass') throw new Error(`${report.suite} did not run ${check}: ${outcome.status}`);
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures for checks: an event authored by a peer and its release.

let eventSequence = 0;

/** An immutable event authored by `author` in `roomId`, with its exact content bytes. */
export function authoredEvent(author: OwnerFixture, roomId: string, label: string): Readonly<{ ref: EventRef; payload: Uint8Array }> {
  const payload = new TextEncoder().encode(`${label}#${++eventSequence}`);
  return {
    payload,
    ref: {
      v: 1,
      roomId: roomId as EventRef['roomId'],
      eventId: `event-${author.seed}-${label}` as EventRef['eventId'],
      authorParticipantId: author.agentParticipantId,
      authorDeviceId: author.deviceId,
      contentDigest: sha256(payload),
    },
  };
}

export function approvalFor(
  owner: OwnerFixture,
  selection: readonly EventRef[],
  commandId: string,
  limits: DeliveryLimits,
  binding: SessionBinding = owner.binding,
): ApprovalCommand {
  const decoded = decodeApprovalCommand({
    v: 1,
    commandId,
    roomId: selection[0]!.roomId,
    bindingId: binding.bindingId,
    expectedPolicyVersion: owner.policyVersion,
    expectedBindingGeneration: binding.generation,
    selection,
    issuedAt: '2026-09-18T00:00:00Z',
  }, limits);
  if (!decoded.ok) throw new Error(`approval fixture invalid at ${decoded.field}`);
  return decoded.value;
}

/** A verified release for `owner` built through the contract constructor only. */
export function releaseFor(
  owner: OwnerFixture,
  events: readonly EventRef[],
  payload: Uint8Array,
  releaseId: string,
  limits: DeliveryLimits,
): ReleasedJob {
  const released = releaseFromApproval({
    approval: approvalFor(owner, events, `approve-${releaseId}`, limits),
    items: events,
    binding: owner.binding,
    policyVersion: owner.policyVersion,
    release: {
      releaseId: releaseId as ReleasedJob['releaseId'],
      payloadRef: `ledger-${releaseId}`,
      payloadDigest: sha256(payload),
      causalRootId: events[0]!.eventId as unknown as ReleasedJob['causalRootId'],
    },
  });
  if (!released.ok) throw new Error(`release fixture rejected: ${released.code}`);
  return released.value;
}

// ---------------------------------------------------------------------------
// Harness adapter conformance.

/** One owner's harness adapter plus the model-facing observation of its session. */
export type HarnessSubject = Readonly<{
  port: HarnessPort;
  /** What the existing model session actually received. */
  modelInputs(): Promise<readonly ModelInput[]>;
  /** Faults this subject can enact at their documented boundary. */
  faults: readonly Fault[];
  close(): Promise<void>;
}>;

export type HarnessSubjectFactory = (scenario: ScenarioHarness, owner: OwnerFixture) => Promise<HarnessSubject>;

const ACCEPTANCE: readonly ReceiptKind[] = ['harness_queued', 'context_consumed', 'completed'];

async function submitCapturing(port: HarnessPort, job: ReleasedJob, payload: Uint8Array) {
  try {
    return { receipt: await port.submit({ job, payload }), disconnected: false as const };
  } catch (error) {
    if (error instanceof InjectedDisconnect) return { receipt: null, disconnected: true as const };
    throw error;
  }
}

function harnessChecks(capabilities: HarnessCapabilities, limits: DeliveryLimits): Check<HarnessSubject>[] {
  const subjectOf = (context: { scenario: ScenarioHarness; subjects: ReadonlyMap<string, HarnessSubject> }, index: number) => {
    const owner = context.scenario.owners[index];
    if (!owner) throw new Error(`the suite needs owner #${index + 1}`);
    return { owner, subject: context.subjects.get(owner.ownerId)! };
  };
  const firstRelease = (owner: OwnerFixture, peer: OwnerFixture, label: string) => {
    const event = authoredEvent(peer, 'room-conformance', label);
    return { event, job: releaseFor(owner, [event.ref], event.payload, `release-${owner.seed}-${label}`, limits) };
  };
  const requireFault = (subject: HarnessSubject, fault: Fault): void => {
    if (!subject.faults.includes(fault)) skip(`subject cannot inject ${fault}`);
  };

  const checks: Check<HarnessSubject>[] = [
    {
      name: 'capabilities.declared',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        const inspected = await subject.port.inspect(owner.binding);
        ensure(JSON.stringify(inspected) === JSON.stringify(capabilities), 'inspect() differs from the registered capabilities');
      },
    },
    {
      name: 'session.identity_preserved',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'identity');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        ensure(receipt.bindingId === owner.binding.bindingId && receipt.generation === owner.binding.generation,
          'receipt names a different binding or generation');
        for (const input of await subject.modelInputs()) {
          ensure(input.bindingId === owner.binding.bindingId && input.sessionId === owner.binding.sessionId
            && input.generation === owner.binding.generation, 'model input landed outside the bound existing session');
        }
      },
    },
    {
      name: 'payload.exact_digest',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'digest');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        const inputs = (await subject.modelInputs()).filter(input => input.releaseId === job.releaseId);
        if (receipt.kind === 'failed') skip(`submission failed (${receipt.errorCode}); digest not observable`);
        ensure(inputs.every(input => input.payloadDigest === job.payloadDigest), 'model received bytes with another digest');
        const tampered = new Uint8Array([...event.payload, 0x20]);
        const second = firstRelease(owner, subjectOf(context, 1).owner, 'tampered');
        const refused = await subject.port.submit({ job: second.job, payload: tampered });
        ensure(refused.kind === 'failed', 'a payload that does not match the release digest was accepted');
        ensure(!(await subject.modelInputs()).some(input => input.releaseId === second.job.releaseId),
          'mismatched payload reached the model');
      },
    },
    {
      name: 'notify.no_pending_hint',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        const { job } = firstRelease(owner, subjectOf(context, 1).owner, 'hint');
        await subject.port.notify(owner.binding, { v: 1, releaseId: job.releaseId });
        ensure((await subject.modelInputs()).length === 0, 'a notification put content into model context');
      },
    },
    {
      name: 'binding.owner_specific',
      async run(context) {
        const { owner: other, subject } = subjectOf(context, 0);
        const { owner: target } = subjectOf(context, 1);
        const bystander = context.scenario.owners[2] ?? other;
        const { job, event } = firstRelease(target, bystander, 'foreign');
        const result = await submitCapturing(subject.port, job, event.payload);
        ensure(!(await subject.modelInputs()).some(input => input.releaseId === job.releaseId),
          `${target.seed}'s release reached ${other.seed}'s session`);
        ensure(result.receipt === null || !ACCEPTANCE.includes(result.receipt.kind),
          `${other.seed}'s adapter reported acceptance of ${target.seed}'s release`);
        ensure(!sameSessionBinding(job.binding, other.binding), 'fixture error: bindings are not distinct');
      },
    },
    {
      name: 'receipt.consumption_is_observed',
      async run(context) {
        if (!capabilities.receiptEvidence.includes('context_consumed')) {
          skip('capabilities do not claim context_consumed receipts');
        }
        const { owner, subject } = subjectOf(context, 0);
        const peer = subjectOf(context, 1).owner;
        const receipts = [];
        for (const label of ['consume-1', 'consume-2']) {
          const { job, event } = firstRelease(owner, peer, label);
          receipts.push({ job, receipt: await subject.port.submit({ job, payload: event.payload }) });
        }
        if (subject.faults.includes('session_exit')) {
          await context.scenario.inject('session_exit', owner.ownerId);
          const { job, event } = firstRelease(owner, peer, 'consume-exit');
          receipts.push({ job, receipt: await subject.port.submit({ job, payload: event.payload }) });
        }
        const inputs = await subject.modelInputs();
        for (const { job, receipt } of receipts) {
          if (receipt.kind !== 'context_consumed') continue;
          ensure(inputs.some(input => input.releaseId === job.releaseId),
            `context_consumed for ${job.releaseId} without a model-facing input`);
        }
      },
    },
    {
      name: 'fault.disconnect_after_write',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        requireFault(subject, 'disconnect_after_write');
        await context.scenario.inject('disconnect_after_write', owner.ownerId);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'unknown');
        const result = await submitCapturing(subject.port, job, event.payload);
        ensure(result.disconnected || result.receipt?.kind === 'outcome_unknown',
          'an unconfirmed write was reported as a definite outcome');
        const reconciled = await subject.port.reconcile(job);
        ensure(reconciled === null || reconciled.releaseId === job.releaseId, 'reconcile answered for another release');
        const count = (await subject.modelInputs()).filter(input => input.releaseId === job.releaseId).length;
        ensure(count <= 1, `model received release ${job.releaseId} ${count} times`);
      },
    },
    {
      name: 'fault.session_exit',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        requireFault(subject, 'session_exit');
        await context.scenario.inject('session_exit', owner.ownerId);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'exit');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        ensure(receipt.kind === 'failed' && receipt.errorCode === 'session_unavailable',
          `exited session reported ${receipt.kind}`);
        ensure((await subject.modelInputs()).length === 0, 'content reached a model after its session exited');
      },
    },
    {
      name: 'fault.session_busy',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        requireFault(subject, 'session_busy');
        if (capabilities.busy === 'unknown') skip('busy behaviour is unknown for this route');
        await context.scenario.inject('session_busy', owner.ownerId);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'busy');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        const count = (await subject.modelInputs()).filter(input => input.releaseId === job.releaseId).length;
        if (capabilities.busy === 'reject') {
          ensure(receipt.kind === 'failed' && receipt.errorCode === 'busy_rejected', `busy reject reported ${receipt.kind}`);
          ensure(count === 0, 'a rejected release reached the model');
        } else {
          ensure(receipt.kind !== 'context_consumed' || count === 1, 'busy session claimed consumption without input');
          ensure(count <= 1, 'busy session received the release more than once');
        }
      },
    },
  ];

  // Receipt kinds the capability record does not claim are reported as explicit
  // skips so a report never implies evidence it lacks.
  for (const kind of RECEIPT_KINDS) {
    if (!capabilities.receiptEvidence.includes(kind)) {
      checks.push({ name: `receipt.${kind}`, run: async () => skip(`capabilities do not claim ${kind} receipts`) });
    }
  }
  return checks;
}

export function runHarnessConformance(
  factory: HarnessSubjectFactory,
  capabilities: HarnessCapabilities,
  environment: SuiteEnvironment,
): Promise<ConformanceReport> {
  if (environment.owners.length < 2) throw new Error('harness conformance needs a subject owner and a peer owner');
  return runChecks(`harness:${capabilities.harness}@${capabilities.version}`, environment,
    harnessChecks(capabilities, environment.limits), factory);
}

// ---------------------------------------------------------------------------
// Delivery (owner connector) conformance.

/** One owner's trusted connector stack as seen from outside. */
export type DeliverySubject = Readonly<{
  approvals: ApprovalPort;
  deliver(event: EventRef, payload: Uint8Array): Promise<void>;
  pending(): Promise<readonly EventRef[]>;
  undecryptable(): Promise<readonly EventRef[]>;
  keysArrived(): Promise<void>;
  /** Restarts the owner process from durable state. */
  restart(): Promise<void>;
  modelInputs(): Promise<readonly ModelInput[]>;
  releaseFacts(releaseId: string): Promise<readonly ReceiptKind[]>;
  faults: readonly Fault[];
  close(): Promise<void>;
}>;

export type DeliverySubjectFactory = (scenario: ScenarioHarness, owner: OwnerFixture) => Promise<DeliverySubject>;

function deliveryChecks(limits: DeliveryLimits): Check<DeliverySubject>[] {
  const room = 'room-1';
  // A authors E7; B and C each hold their own pending copy.
  const setup = async (context: { scenario: ScenarioHarness; subjects: ReadonlyMap<string, DeliverySubject> }) => {
    const [a, b, c] = context.scenario.owners;
    if (!a || !b || !c) throw new Error('delivery conformance needs owners A, B and C');
    const at = (owner: OwnerFixture) => context.subjects.get(owner.ownerId)!;
    const e7 = authoredEvent(a, room, '7');
    return { a, b, c, at, e7 };
  };
  const grant = (owner: OwnerFixture) => ownerAuthority(owner, {
    authorizationId: `authz-${owner.seed}`,
    authenticatedAt: '2026-09-18T00:00:00Z',
  });
  const requireFault = (subject: DeliverySubject, fault: Fault): void => {
    if (!subject.faults.includes(fault)) skip(`subject cannot inject ${fault}`);
  };
  const released = (inputs: readonly ModelInput[]) => inputs.length;

  return [
    {
      name: 'pending.not_in_model_context',
      async run(context) {
        const { b, c, at, e7 } = await setup(context);
        for (const owner of [b, c]) await at(owner).deliver(e7.ref, e7.payload);
        for (const owner of [b, c]) {
          ensure((await at(owner).pending()).length === 1, `${owner.seed} has no pending copy of E7`);
          ensure(released(await at(owner).modelInputs()) === 0, `${owner.seed}'s model saw pending E7 before approval`);
        }
      },
    },
    {
      name: 'authority.cross_owner_release',
      async run(context) {
        const { a, b, at, e7 } = await setup(context);
        await at(b).deliver(e7.ref, e7.payload);
        const result = await at(b).approvals.approve(grant(a), approvalFor(b, [e7.ref], 'cross-1', limits));
        ensure(!result.ok && result.code === 'forbidden', `A's authority on B's connector returned ${result.ok ? 'ok' : result.code}`);
        ensure(released(await at(b).modelInputs()) === 0, "A's approval released E7 into B's agent");
      },
    },
    {
      name: 'authority.owner_specific_release',
      async run(context) {
        const { b, c, at, e7 } = await setup(context);
        for (const owner of [b, c]) await at(owner).deliver(e7.ref, e7.payload);
        const result = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-approves-e7', limits));
        ensure(result.ok, `B's own approval failed: ${result.ok ? '' : result.code}`);
        const inputs = await at(b).modelInputs();
        ensure(inputs.length === 1 && inputs[0]!.bindingId === b.binding.bindingId, "E7 did not reach B's session exactly once");
        ensure(released(await at(c).modelInputs()) === 0, "B's approval released C's copy");
        ensure((await at(c).pending()).length === 1, "B's approval removed C's pending copy");
      },
    },
    {
      name: 'unknown.no_repeat_submit',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        requireFault(at(b), 'disconnect_after_write');
        await at(b).deliver(e7.ref, e7.payload);
        await context.scenario.inject('disconnect_after_write', b.ownerId);
        const result = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-unknown', limits));
        ensure(!result.ok && result.code === 'outcome_unknown', `unconfirmed write reported ${result.ok ? 'ok' : result.code}`);
        await at(b).restart();
        const count = released(await at(b).modelInputs());
        ensure(count <= 1, `model received E7 ${count} times after an unknown outcome`);
      },
    },
    {
      name: 'crash_after_intent.reconciled',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        requireFault(at(b), 'crash_after_intent');
        await at(b).deliver(e7.ref, e7.payload);
        await context.scenario.inject('crash_after_intent', b.ownerId);
        let crashed = false;
        try {
          await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-crash', limits));
        } catch (error) {
          crashed = (error as Error).name === 'InjectedCrash';
          if (!crashed) throw error;
        }
        ensure(crashed, 'crash_after_intent did not interrupt the approval');
        await at(b).restart();
        const inputs = await at(b).modelInputs();
        ensure(inputs.length <= 1, 'restart resubmitted a release with an unknown outcome');
      },
    },
    {
      name: 'duplicate_event.single_pending',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        requireFault(at(b), 'duplicate_event');
        await context.scenario.inject('duplicate_event', b.ownerId);
        await at(b).deliver(e7.ref, e7.payload);
        ensure((await at(b).pending()).length === 1, 'a redelivered event became two pending items');
      },
    },
    {
      name: 'keys_delayed.visible_not_releasable',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        requireFault(at(b), 'keys_delayed');
        await context.scenario.inject('keys_delayed', b.ownerId);
        await at(b).deliver(e7.ref, e7.payload);
        ensure((await at(b).undecryptable()).length === 1, 'an event without keys disappeared');
        const early = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-early', limits));
        ensure(!early.ok, 'an undecryptable event was released');
        await at(b).keysArrived();
        ensure((await at(b).pending()).length === 1, 'the event did not become pending once keys arrived');
      },
    },
    {
      name: 'reordered_receipt.facts_not_progress',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        requireFault(at(b), 'reordered_receipt');
        await at(b).deliver(e7.ref, e7.payload);
        const result = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-receipts', limits));
        if (!result.ok) throw new CheckFailed(`approval failed: ${result.code}`);
        const releaseId = result.releaseIds[0]!;
        const before = new Set(await at(b).releaseFacts(releaseId));
        await context.scenario.inject('reordered_receipt', b.ownerId);
        await at(b).restart();
        const after = new Set(await at(b).releaseFacts(releaseId));
        ensure([...before].every(kind => after.has(kind)), 'a later receipt erased an earlier fact');
      },
    },
  ];
}

export function runDeliveryConformance(factory: DeliverySubjectFactory, environment: SuiteEnvironment): Promise<ConformanceReport> {
  if (environment.owners.length < 3) throw new Error('delivery conformance needs owners A, B and C');
  return runChecks('delivery', environment, deliveryChecks(environment.limits), factory);
}
