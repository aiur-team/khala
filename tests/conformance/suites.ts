// Neutral conformance suites. Each check runs in its own fresh scenario and returns
// pass, fail with a reason, or skip with a reason. A skipped check is never counted
// as a pass, and unsupported capabilities are skipped rather than synthesized.

import { isDeepStrictEqual } from 'node:util';
import {
  type ApprovalCommand, type ApprovalPort, type DeliveryLimits, type DeliveryReceipt, type EventRef, type HarnessCapabilities, type HarnessPort,
  type PolicySetCommand, type ReceiptKind, type ReleasedJob, RECEIPT_KINDS, type SessionBinding, decodeApprovalCommand,
  decodePolicySetCommand, releaseFromApproval, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { type EvidenceManifest, type EvidenceMode, type SourceVersion, isLiveMode } from '../e2e/harness/evidence';
import { type Fault, InjectedDisconnect } from '../e2e/harness/faults';
import { type LiveEnvironment, liveEnvironment } from '../e2e/harness/live';
import { type OwnerControls, type OwnerFixture, nextGeneration, ownerAuthority } from '../e2e/harness/owners';
import { type ModelInput, sha256 } from '../e2e/harness/reference';
import { type ScenarioDriver, type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../e2e/harness/scenario';

export type CheckOutcome =
  | Readonly<{ status: 'pass' }>
  | Readonly<{ status: 'fail'; reason: string }>
  | Readonly<{ status: 'skip'; reason: string }>;

export type CheckResult = Readonly<{ check: string; outcome: CheckOutcome }>;

export type ConformanceReport = Readonly<{
  suite: string;
  mode: EvidenceMode;
  results: readonly CheckResult[];
  /** One manifest per check, in check order. */
  manifests: readonly EvidenceManifest[];
}>;

// Reports built by `runChecks`. A hand-built object of the same shape is not a report.
const issuedReports = new WeakSet<ConformanceReport>();

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
  /**
   * Fresh drivers for each check. Required in live modes: live evidence and live
   * faults come only through a registered driver's handle, never from in-process fakes.
   */
  drivers?: () => readonly ScenarioDriver[];
}>;

type Check<Subject> = Readonly<{
  name: string;
  run: (context: Readonly<{ scenario: ScenarioHarness; subjects: ReadonlyMap<string, Subject> }>) => Promise<void>;
}>;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function runChecks<Subject extends { mode: EvidenceMode; close(): Promise<void> }>(
  suite: string,
  environment: SuiteEnvironment,
  checks: readonly Check<Subject>[],
  factory: (scenario: ScenarioHarness, owner: OwnerFixture) => Promise<Subject>,
): Promise<ConformanceReport> {
  const results: CheckResult[] = [];
  const manifests: EvidenceManifest[] = [];
  const live = isLiveMode(environment.mode);
  for (const [index, check] of checks.entries()) {
    const scenario = await createScenarioHarness({
      runId: `conformance-${slug(suite)}-${index}`,
      mode: environment.mode,
      owners: environment.owners,
      sources: environment.sources,
      ...(environment.drivers ? { drivers: environment.drivers() } : {}),
    });
    let outcome: CheckOutcome;
    try {
      const subjects = new Map<string, Subject>();
      for (const owner of scenario.owners) {
        const subject = await factory(scenario, owner);
        subjects.set(owner.ownerId, subject);
        scenario.defer(`subject:${owner.seed}`, owner.ownerId, () => subject.close());
        // The subject declares what its evidence is; the suite never relabels it.
        ensure(subject.mode === environment.mode, `subject produces ${subject.mode} evidence in a ${environment.mode} suite`);
      }
      await check.run({ scenario, subjects });
      // A live pass must rest on evidence a registered driver produced.
      ensure(!live || scenario.evidence().length > 0, 'passed without any live evidence from a registered driver');
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
    manifests.push(scenario.manifest());
  }
  const report: ConformanceReport = Object.freeze({
    suite, mode: environment.mode, results: Object.freeze(results), manifests: Object.freeze(manifests),
  });
  issuedReports.add(report);
  return report;
}

export function outcomeOf(report: ConformanceReport, check: string): CheckOutcome {
  const result = report.results.find(entry => entry.check === check);
  if (!result) throw new Error(`${report.suite} has no check ${check}`);
  return result.outcome;
}

/** Checks live harness acceptance requires unless a caller names a larger set. */
export const CORE_LIVE_HARNESS_CHECKS: readonly string[] = [
  'capabilities.declared',
  'session.identity_preserved',
  'payload.exact_digest',
  'notify.no_pending_hint',
  'binding.owner_specific',
  'binding.revoked_blocks',
  'receipt.consumption_is_observed',
];

/**
 * Accepts a report as live harness evidence. Refused: a report `runChecks` did not
 * build, a fake report, a run outside an opted-in live environment, an empty required
 * set, any failed check, and any required check that did not pass.
 */
export function acceptLiveHarness(
  report: ConformanceReport,
  options: Readonly<{ required?: readonly string[]; environment?: LiveEnvironment }> = {},
): void {
  if (!issuedReports.has(report)) throw new Error('only a report produced by a conformance run can be accepted');
  if (report.mode !== 'live-harness') {
    throw new Error(`${report.suite} is ${report.mode} evidence; live harness acceptance needs live-harness`);
  }
  const environment = options.environment ?? liveEnvironment();
  if (!environment.enabled) throw new Error(`live harness acceptance needs an opted-in live environment: ${environment.reason}`);
  const required = options.required ?? CORE_LIVE_HARNESS_CHECKS;
  if (required.length === 0) throw new Error('live harness acceptance needs at least one required check');
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

function policyCommand(owner: OwnerFixture, peer: OwnerFixture, mode: PolicySetCommand['mode'], commandId: string): PolicySetCommand {
  const decoded = decodePolicySetCommand({
    v: 1,
    commandId,
    roomId: 'room-1',
    bindingId: owner.binding.bindingId,
    peerParticipantId: peer.agentParticipantId,
    expectedPolicyVersion: owner.policyVersion,
    expectedBindingGeneration: owner.binding.generation,
    mode,
    paused: false,
    issuedAt: '2026-09-18T00:00:00Z',
  });
  if (!decoded.ok) throw new Error(`policy fixture invalid at ${decoded.field}`);
  return decoded.value;
}

// ---------------------------------------------------------------------------
// Harness adapter conformance.

/**
 * One owner's harness adapter plus the model-facing observation of its session.
 *
 * Faults: a subject lists the faults it can enact. A fake enacts them from built-in
 * `checkpoint` calls. A real component implements `inject`, which prepares its native
 * seam (a host registry, an app-server reply, a thread status) to call `checkpoint`
 * at the fault's boundary and act the fault out natively when it fires.
 */
export type HarnessSubject = Readonly<{
  /** The evidence this subject produces: a fake adapter is `fake-contract`, whatever it claims. */
  mode: EvidenceMode;
  port: HarnessPort;
  /** What the existing model session actually received. */
  modelInputs(): Promise<readonly ModelInput[]>;
  /** Receipts observed after `submit` returned, for example from a native receipt tracker. */
  receipts(): Promise<readonly DeliveryReceipt[]>;
  /** Lets the session finish any running turn and consume what is queued; ends a busy fault. */
  settle(): Promise<void>;
  /** Faults this subject can enact at their documented boundary. */
  faults: readonly Fault[];
  inject?(fault: Fault): Promise<void>;
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
  type Context = { scenario: ScenarioHarness; subjects: ReadonlyMap<string, HarnessSubject> };
  const subjectOf = (context: Context, index: number) => {
    const owner = context.scenario.owners[index];
    if (!owner) throw new Error(`the suite needs owner #${index + 1}`);
    return { owner, subject: context.subjects.get(owner.ownerId)! };
  };
  const firstRelease = (owner: OwnerFixture, peer: OwnerFixture, label: string) => {
    const event = authoredEvent(peer, 'room-conformance', label);
    return { event, job: releaseFor(owner, [event.ref], event.payload, `release-${owner.seed}-${label}`, limits) };
  };
  const inject = async (context: Context, subject: HarnessSubject, owner: OwnerFixture, fault: Fault) => {
    if (!subject.faults.includes(fault)) skip(`subject cannot inject ${fault}`);
    await context.scenario.inject(fault, owner.ownerId);
    await subject.inject?.(fault);
  };
  /** Every receipt for `job`: the one `submit` returned plus any observed afterwards. */
  const receiptsFor = async (subject: HarnessSubject, job: ReleasedJob, returned: DeliveryReceipt | null) => [
    ...(returned ? [returned] : []),
    ...(await subject.receipts()).filter(entry => entry.releaseId === job.releaseId),
  ];
  const inputsFor = async (subject: HarnessSubject, job: ReleasedJob) => (await subject.modelInputs()).filter(input => input.releaseId === job.releaseId);

  // Delivery-success and fault checks skip unsupported adapters because
  // support.fail_closed exclusively owns their no-delivery invariant.
  const checks: Check<HarnessSubject>[] = [
    {
      name: 'capabilities.declared',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        const inspected = await subject.port.inspect(owner.binding);
        ensure(isDeepStrictEqual(inspected, capabilities), 'inspect() differs from the registered capabilities');
      },
    },
    {
      name: 'session.identity_preserved',
      async run(context) {
        if (capabilities.support === 'unsupported') skip('native delivery support is unsupported');
        const { owner, subject } = subjectOf(context, 0);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'identity');
        const returned = await subject.port.submit({ job, payload: event.payload });
        ensure(returned.kind !== 'failed', `a healthy session refused a valid release (${returned.errorCode})`);
        await subject.settle();
        const receipts = await receiptsFor(subject, job, returned);
        for (const receipt of receipts) {
          ensure(receipt.bindingId === owner.binding.bindingId && receipt.generation === owner.binding.generation,
            `a ${receipt.kind} receipt names a different binding or generation`);
        }
        const inputs = await subject.modelInputs();
        if (receipts.some(receipt => receipt.kind === 'context_consumed')) {
          ensure(inputs.some(input => input.releaseId === job.releaseId), 'consumption reported but no model input observed');
        }
        for (const input of inputs) {
          ensure(input.bindingId === owner.binding.bindingId && input.sessionId === owner.binding.sessionId
            && input.generation === owner.binding.generation, 'model input landed outside the bound existing session');
        }
      },
    },
    {
      name: 'payload.exact_digest',
      async run(context) {
        if (capabilities.support === 'unsupported') skip('native delivery support is unsupported');
        const { owner, subject } = subjectOf(context, 0);
        const peer = subjectOf(context, 1).owner;
        const { job, event } = firstRelease(owner, peer, 'digest');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        ensure(receipt.kind !== 'failed', `a healthy session refused a valid release (${receipt.errorCode})`);
        const tampered = new Uint8Array([...event.payload, 0x20]);
        const second = firstRelease(owner, peer, 'tampered');
        const refused = await subject.port.submit({ job: second.job, payload: tampered });
        ensure(refused.kind === 'failed', 'a payload that does not match the release digest was accepted');
        await subject.settle();
        ensure((await inputsFor(subject, job)).every(input => input.payloadDigest === job.payloadDigest), 'model received bytes with another digest');
        ensure((await inputsFor(subject, second.job)).length === 0, 'mismatched payload reached the model');
      },
    },
    {
      name: 'notify.no_pending_hint',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        const { job } = firstRelease(owner, subjectOf(context, 1).owner, 'hint');
        await subject.port.notify(owner.binding, { v: 1, releaseId: job.releaseId });
        await subject.settle();
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
        await subject.settle();
        ensure((await inputsFor(subject, job)).length === 0, `${target.seed}'s release reached ${other.seed}'s session`);
        ensure(result.receipt === null || !ACCEPTANCE.includes(result.receipt.kind),
          `${other.seed}'s adapter reported acceptance of ${target.seed}'s release`);
        ensure(!sameSessionBinding(job.binding, other.binding), 'fixture error: bindings are not distinct');
      },
    },
    {
      name: 'binding.revoked_blocks',
      async run(context) {
        // Revocation re-arms the binding at the next generation. A job for a generation
        // the session does not serve must not reach it, even with the same binding ID.
        const { owner, subject } = subjectOf(context, 0);
        const rearmed = nextGeneration(owner);
        const { job, event } = firstRelease(rearmed, subjectOf(context, 1).owner, 'revoked');
        ensure(job.binding.bindingId === owner.binding.bindingId, 'fixture error: re-arm changed the binding ID');
        const result = await submitCapturing(subject.port, job, event.payload);
        await subject.settle();
        ensure((await inputsFor(subject, job)).length === 0, 'a release for another binding generation reached the session');
        ensure(result.receipt === null || result.receipt.kind === 'failed',
          `a release for another binding generation reported ${result.receipt?.kind}`);
      },
    },
    {
      name: 'receipt.consumption_is_observed',
      async run(context) {
        if (capabilities.support === 'unsupported') skip('native delivery support is unsupported');
        // Submissions run even when consumption is unclaimed, so an adapter that emits
        // unclaimed context_consumed receipts fails instead of skipping.
        const { owner, subject } = subjectOf(context, 0);
        const peer = subjectOf(context, 1).owner;
        const submitted: { job: ReleasedJob; receipt: DeliveryReceipt }[] = [];
        for (const label of ['consume-1', 'consume-2']) {
          const { job, event } = firstRelease(owner, peer, label);
          submitted.push({ job, receipt: await subject.port.submit({ job, payload: event.payload }) });
        }
        ensure(submitted.some(({ receipt }) => receipt.kind !== 'failed'), 'every valid submission failed; consumption was never exercised');
        await subject.settle();
        if (subject.faults.includes('session_exit')) {
          await inject(context, subject, owner, 'session_exit');
          const { job, event } = firstRelease(owner, peer, 'consume-exit');
          submitted.push({ job, receipt: await subject.port.submit({ job, payload: event.payload }) });
          await subject.settle();
        }
        const receipts = (await Promise.all(submitted.map(({ job, receipt }) => receiptsFor(subject, job, receipt)))).flat();
        if (!capabilities.receiptEvidence.includes('context_consumed')) {
          skip('capabilities do not claim context_consumed receipts');
        }
        const inputs = await subject.modelInputs();
        const consumed = receipts.filter(receipt => receipt.kind === 'context_consumed');
        ensure(consumed.length > 0, 'capabilities claim context_consumed but no submission produced one');
        for (const receipt of consumed) {
          ensure(inputs.some(input => input.releaseId === receipt.releaseId),
            `context_consumed for ${receipt.releaseId} without a model-facing input`);
        }
      },
    },
    {
      name: 'fault.disconnect_after_write',
      async run(context) {
        if (capabilities.support === 'unsupported') skip('native delivery support is unsupported');
        const { owner, subject } = subjectOf(context, 0);
        await inject(context, subject, owner, 'disconnect_after_write');
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'unknown');
        const result = await submitCapturing(subject.port, job, event.payload);
        ensure(result.disconnected || result.receipt?.kind === 'outcome_unknown',
          'an unconfirmed write was reported as a definite outcome');
        const reconciled = await subject.port.reconcile(job);
        ensure(reconciled === null || reconciled.releaseId === job.releaseId, 'reconcile answered for another release');
        await subject.settle();
        const count = (await inputsFor(subject, job)).length;
        ensure(count <= 1, `model received release ${job.releaseId} ${count} times`);
      },
    },
    {
      name: 'fault.session_exit',
      async run(context) {
        if (capabilities.support === 'unsupported') skip('native delivery support is unsupported');
        const { owner, subject } = subjectOf(context, 0);
        await inject(context, subject, owner, 'session_exit');
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'exit');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        ensure(receipt.kind === 'failed' && receipt.errorCode === 'session_unavailable',
          `exited session reported ${receipt.kind}`);
        await subject.settle();
        ensure((await subject.modelInputs()).length === 0, 'content reached a model after its session exited');
      },
    },
    {
      name: 'fault.session_busy',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        if (!subject.faults.includes('session_busy')) skip('subject cannot inject session_busy');
        if (capabilities.busy === 'unknown') skip('busy behaviour is unknown for this route');
        await inject(context, subject, owner, 'session_busy');
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'busy');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        const whileBusy = (await inputsFor(subject, job)).length;
        if (capabilities.busy === 'reject') {
          ensure(receipt.kind === 'failed' && receipt.errorCode === 'busy_rejected', `busy reject reported ${receipt.kind}`);
          ensure(whileBusy === 0, 'a rejected release reached the model');
        } else {
          // A queue route must hold the release while the session is busy; writing it
          // straight through means the busy fault was ignored.
          ensure(receipt.kind === 'harness_queued', `busy queue reported ${receipt.kind}`);
          ensure(whileBusy === 0, 'a busy session received the release before its turn ended');
          await subject.settle();
          const delivered = (await inputsFor(subject, job)).length;
          ensure(delivered === 1, `the queued release reached the model ${delivered} times once the session was idle`);
        }
      },
    },
  ];

  if (capabilities.support === 'unsupported') {
    checks.splice(1, 0, {
      name: 'support.fail_closed',
      async run(context) {
        const { owner, subject } = subjectOf(context, 0);
        await subject.port.inspect(owner.binding);
        const { job, event } = firstRelease(owner, subjectOf(context, 1).owner, 'unsupported');
        const receipt = await subject.port.submit({ job, payload: event.payload });
        ensure(receipt.kind === 'failed' && receipt.errorCode === 'harness_unavailable',
          `an unsupported adapter returned ${receipt.kind} (${receipt.errorCode}), expected failed (harness_unavailable)`);
        await subject.settle();
        ensure((await inputsFor(subject, job)).length === 0, 'an unsupported adapter delivered content to the model');
      },
    });
  }

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
    harnessChecks(capabilities, environment.limits), claimedReceiptsOnly(factory, capabilities));
}

/**
 * Fails any check in which the adapter emits a receipt kind its capability record
 * does not claim, so an unclaimed kind cannot hide behind a capability skip.
 */
function claimedReceiptsOnly(factory: HarnessSubjectFactory, capabilities: HarnessCapabilities): HarnessSubjectFactory {
  const claimed = <T extends DeliveryReceipt | null>(receipt: T): T => {
    ensure(receipt === null || capabilities.receiptEvidence.includes(receipt.kind),
      `adapter emitted ${receipt?.kind} receipts its capabilities do not claim`);
    return receipt;
  };
  return async (scenario, owner) => {
    const subject = await factory(scenario, owner);
    const { port } = subject;
    return {
      ...subject,
      receipts: async () => (await subject.receipts()).map(claimed),
      port: {
        inspect: binding => port.inspect(binding),
        notify: (binding, hint) => port.notify(binding, hint),
        submit: async input => claimed(await port.submit(input)),
        reconcile: async job => claimed(await port.reconcile(job)),
        close: () => port.close(),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Delivery (owner connector) conformance.

/** Ledger states for a release. `unknown` and `reconciling` never license a new submission. */
export type ReleaseLedgerState = 'intent' | 'submitted' | 'unknown' | 'reconciling';

/** One owner's trusted connector stack as seen from outside. */
export type DeliverySubject = Readonly<{
  mode: EvidenceMode;
  approvals: ApprovalPort;
  deliver(event: EventRef, payload: Uint8Array): Promise<void>;
  pending(): Promise<readonly EventRef[]>;
  undecryptable(): Promise<readonly EventRef[]>;
  keysArrived(): Promise<void>;
  /** Restarts the owner process from durable state. */
  restart(): Promise<void>;
  /** Revokes the current binding and re-arms the same session at the next generation. */
  revoke(): Promise<void>;
  /** Every release the connector created, with its ledger state. */
  releases(): Promise<readonly Readonly<{ releaseId: string; state: ReleaseLedgerState }>[]>;
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
      name: 'policy.auto_refused',
      async run(context) {
        // G-AUTOMATION is open: no connector may accept `auto` mode.
        const { a, b, at } = await setup(context);
        const auto = await at(b).approvals.setPolicy(grant(b), policyCommand(b, a, 'auto', 'policy-b-auto'));
        ensure(auto.connectorState === 'rejected' && auto.effectiveVersion === null, `auto mode was ${auto.connectorState}`);
        // The refusal must not have moved the policy version either.
        const review = await at(b).approvals.setPolicy(grant(b), policyCommand(b, a, 'review', 'policy-b-review'));
        ensure(review.connectorState === 'effective', `a review policy at the original version was ${review.connectorState}`);
      },
    },
    {
      name: 'binding.revoked_blocks',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        await at(b).deliver(e7.ref, e7.payload);
        await at(b).revoke();
        // Approved against the revoked generation, which the owner's UI may still show.
        const result = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-revoked', limits));
        ensure(!result.ok && result.code === 'stale_binding', `approval for a revoked binding returned ${result.ok ? 'ok' : result.code}`);
        ensure(released(await at(b).modelInputs()) === 0, 'an approval for a revoked binding reached the model');
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
        // `outcome_unknown` is never resubmitted. Only reconciliation that proves absence
        // could license a submit, and no RECONCILE_SUPPORT value does: `while_queued`
        // cannot tell a consumed release from one never sent.
        ensure(released(await at(b).modelInputs()) === 0, 'restart submitted a release whose outcome is unknown');
        const ledger = await at(b).releases();
        ensure(ledger.length === 1, `expected one release in the ledger, saw ${ledger.length}`);
        ensure(ledger[0]!.state === 'unknown' || ledger[0]!.state === 'reconciling',
          `after restart the crashed release is ${ledger[0]!.state}, not unknown or reconciling`);
      },
    },
    {
      name: 'duplicate_event.single_pending',
      async run(context) {
        const { b, at, e7 } = await setup(context);
        requireFault(at(b), 'duplicate_event');
        await context.scenario.inject('duplicate_event', b.ownerId);
        await at(b).deliver(e7.ref, e7.payload);
        // A plain redelivery as well, so dedupe is exercised even if the fault is ignored.
        await at(b).deliver(e7.ref, e7.payload);
        ensure((await at(b).pending()).length === 1, 'a redelivered event became two pending items');
        const result = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-duplicate', limits));
        ensure(result.ok, `approval of the deduplicated event failed: ${result.ok ? '' : result.code}`);
        const count = released(await at(b).modelInputs());
        ensure(count === 1, `a redelivered event reached the model ${count} times`);
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
        requireFault(at(b), 'disconnect_after_write');
        await at(b).deliver(e7.ref, e7.payload);
        // An unconfirmed write followed by reconciliation yields two distinct facts
        // (outcome_unknown, then context_consumed), so reversing them is observable.
        await context.scenario.inject('disconnect_after_write', b.ownerId);
        const result = await at(b).approvals.approve(grant(b), approvalFor(b, [e7.ref], 'b-receipts', limits));
        ensure(!result.ok && result.code === 'outcome_unknown', `unconfirmed write reported ${result.ok ? 'ok' : result.code}`);
        await at(b).restart();
        const [written] = await at(b).modelInputs();
        ensure(written !== undefined, 'the unconfirmed write never reached the model');
        const { releaseId } = written;
        const before = new Set(await at(b).releaseFacts(releaseId));
        ensure(before.size >= 2, `needs two distinct receipt facts to reorder, saw ${[...before].join(', ') || 'none'}`);
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
