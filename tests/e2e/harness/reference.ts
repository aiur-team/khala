// Reference fakes for harness self-tests and conformance oracles. They use the real
// contract constructors (`releaseFromApproval`, receipt decoding) and enact faults
// at their documented boundaries, but they are `fake-contract` evidence only and are
// never a product implementation. `defect` switches in deliberate bugs so each
// conformance oracle can be shown to fail.

import { createHash } from 'node:crypto';
import {
  type ApprovalCommand, type ApprovalPort, type ApprovalResult, type DeliveryLimits, type DeliveryReceipt,
  type EventRef, type HarnessCapabilities, type HarnessPort, type OwnerAuthority, type PolicyAck,
  type PolicySetCommand, type ReceiptErrorCode, type ReceiptKind, type ReleasedJob, type SessionBinding,
  decodeDeliveryReceipt, decodeOperationId, releaseFromApproval, sameApprovalCommandInput, sameEventIdentity,
  sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { InjectedCrash, InjectedDisconnect } from './faults';
import type { OwnerFixture } from './owners';
import type { ScenarioHarness } from './scenario';

/** What the model session actually received: the model-facing oracle. */
export type ModelInput = Readonly<{
  releaseId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
  payloadDigest: string;
}>;

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; field: string }, what: string): T {
  if (!result.ok) throw new Error(`${what} is not a valid contract value (${result.field || 'root'})`);
  return result.value;
}

/** Receipt timestamps: live clocks give wall time; fake clocks count from a fixed epoch. */
const FAKE_EPOCH_MS = Date.UTC(2026, 8, 18);
function observedAt(scenario: ScenarioHarness, ownerId: string): string {
  const clock = scenario.clock(ownerId);
  return clock.wallClock() ?? new Date(FAKE_EPOCH_MS + Math.floor(clock.now())).toISOString();
}

let receiptSequence = 0;
function receipt(
  scenario: ScenarioHarness,
  owner: OwnerFixture,
  job: ReleasedJob,
  kind: ReceiptKind,
  source: 'connector' | 'harness',
  errorCode: ReceiptErrorCode | null = null,
): DeliveryReceipt {
  const value = unwrap(decodeDeliveryReceipt({
    v: 1,
    receiptId: `receipt-${job.releaseId}-${kind}-${++receiptSequence}`,
    releaseId: job.releaseId,
    bindingId: job.binding.bindingId,
    generation: job.binding.generation,
    kind,
    observedAt: observedAt(scenario, owner.ownerId),
    source,
    evidenceRef: null,
    errorCode,
  }), 'receipt');
  scenario.record(`receipt.${kind}`, { ownerId: owner.ownerId, operationId: job.releaseId });
  return value;
}

export type AdapterDefect = 'cross_owner_release' | 'false_consumption';

export interface FakeHarnessAdapter extends HarnessPort {
  modelInputs(): readonly ModelInput[];
  /** Release IDs seen through `notify`; hints carry no content. */
  hints(): readonly string[];
}

/**
 * One owner's existing model session. It accepts only jobs for its own binding and
 * generation, verifies the payload digest, and writes each accepted release to the
 * model once.
 */
export function createFakeHarnessAdapter(input: Readonly<{
  scenario: ScenarioHarness;
  owner: OwnerFixture;
  capabilities: HarnessCapabilities;
  defect?: AdapterDefect;
}>): FakeHarnessAdapter {
  const { scenario, owner, capabilities, defect } = input;
  const inputs: ModelInput[] = [];
  const queued = new Map<string, ModelInput>();
  const hints: string[] = [];

  const write = (job: ReleasedJob): void => {
    inputs.push({
      releaseId: job.releaseId,
      bindingId: job.binding.bindingId,
      sessionId: job.binding.sessionId,
      generation: job.binding.generation,
      payloadDigest: job.payloadDigest,
    });
    scenario.record('model.input', { ownerId: owner.ownerId, operationId: job.releaseId });
  };

  return {
    async inspect(binding) {
      if (!sameSessionBinding(binding, owner.binding)) throw new Error('binding is not this session');
      return capabilities;
    },
    async notify(binding, hint) {
      if (!sameSessionBinding(binding, owner.binding)) throw new Error('binding is not this session');
      hints.push(hint.releaseId);
    },
    async submit({ job, payload }) {
      if (defect !== 'cross_owner_release' && !sameSessionBinding(job.binding, owner.binding)) {
        return receipt(scenario, owner, job, 'failed', 'harness', 'stale_binding');
      }
      if (payload.byteLength > capabilities.limits.maxPayloadBytes) {
        return receipt(scenario, owner, job, 'failed', 'harness', 'limit_exceeded');
      }
      if (sha256(payload) !== job.payloadDigest) {
        return receipt(scenario, owner, job, 'failed', 'harness', 'payload_digest_mismatch');
      }
      if (inputs.some(entry => entry.releaseId === job.releaseId) || queued.has(job.releaseId)) {
        // The session already has this release; accepting it again would duplicate model input.
        return receipt(scenario, owner, job, 'failed', 'harness', 'harness_rejected');
      }
      scenario.faults.checkpoint('transport.before_write', owner.ownerId, job.releaseId);
      const accept = scenario.faults.checkpoint('harness.accept', owner.ownerId, job.releaseId);
      if (accept === 'session_exit') {
        if (defect === 'false_consumption') return receipt(scenario, owner, job, 'context_consumed', 'harness');
        return receipt(scenario, owner, job, 'failed', 'harness', 'session_unavailable');
      }
      if (accept === 'session_busy') {
        if (capabilities.busy !== 'queue') return receipt(scenario, owner, job, 'failed', 'harness', 'busy_rejected');
        queued.set(job.releaseId, {
          releaseId: job.releaseId,
          bindingId: job.binding.bindingId,
          sessionId: job.binding.sessionId,
          generation: job.binding.generation,
          payloadDigest: job.payloadDigest,
        });
        return receipt(scenario, owner, job, 'harness_queued', 'harness');
      }
      write(job);
      scenario.faults.checkpoint('transport.after_write', owner.ownerId, job.releaseId);
      return receipt(scenario, owner, job, 'context_consumed', 'harness');
    },
    async reconcile(job) {
      if (inputs.some(entry => entry.releaseId === job.releaseId)) {
        return receipt(scenario, owner, job, 'context_consumed', 'harness');
      }
      if (queued.has(job.releaseId)) return receipt(scenario, owner, job, 'harness_queued', 'harness');
      return null;
    },
    async close() {
      queued.clear();
    },
    modelInputs: () => [...inputs, ...queued.values()].filter(entry => inputs.includes(entry)),
    hints: () => [...hints],
  };
}

export type ConnectorDefect = 'cross_owner_release' | 'repeat_submit_after_unknown';

type LedgerEntry = {
  job: ReleasedJob;
  payload: Uint8Array;
  state: 'intent' | 'submitted' | 'unknown';
  receipts: DeliveryReceipt[];
};

export interface ReferenceConnector extends ApprovalPort {
  readonly owner: OwnerFixture;
  deliver(event: EventRef, payload: Uint8Array): Promise<void>;
  /** Owner-local pending events; never part of model context. */
  pending(): readonly EventRef[];
  undecryptable(): readonly EventRef[];
  keysArrived(): void;
  /** Durable-state restart: unresolved releases are reconciled, never blindly resubmitted. */
  restart(): Promise<void>;
  /** Observed receipt kinds for a release, as a set of facts in arrival order. */
  releaseFacts(releaseId: string): readonly ReceiptKind[];
  ingestReceipts(receipts: readonly DeliveryReceipt[]): void;
  policyVersion(): number;
}

/**
 * One owner's trusted connector: durable pending inbox, owner-authenticated
 * approval, release through the contract constructor, and an intent ledger.
 */
export function createReferenceConnector(input: Readonly<{
  scenario: ScenarioHarness;
  owner: OwnerFixture;
  adapter: HarnessPort;
  limits: DeliveryLimits;
  defect?: ConnectorDefect;
}>): ReferenceConnector {
  const { scenario, owner, adapter, defect } = input;
  const inbox: { ref: EventRef; payload: Uint8Array; decryptable: boolean }[] = [];
  const ledger = new Map<string, LedgerEntry>();
  const commands = new Map<string, { command: ApprovalCommand; result: ApprovalResult }>();
  let binding: SessionBinding = owner.binding;
  let policyVersion = owner.policyVersion;
  let operationSequence = 0;

  const record = (kind: string, operationId: string): void => {
    scenario.record(kind, { ownerId: owner.ownerId, operationId });
  };

  const submit = async (entry: LedgerEntry): Promise<boolean> => {
    try {
      entry.receipts.push(await adapter.submit({ job: entry.job, payload: entry.payload }));
      entry.state = 'submitted';
      return true;
    } catch (error) {
      if (!(error instanceof InjectedDisconnect)) throw error;
      // The write may or may not have reached the session: unknown, not failure.
      entry.state = 'unknown';
      entry.receipts.push(receipt(scenario, owner, entry.job, 'outcome_unknown', 'connector', 'disconnected'));
      return false;
    }
  };

  const reconcile = async (entry: LedgerEntry): Promise<void> => {
    const found = await adapter.reconcile(entry.job);
    if (found) {
      entry.receipts.push(found);
      entry.state = 'submitted';
    }
    // Not found proves nothing when reconciliation only covers queued work; the
    // release stays unknown instead of licensing a second submission.
  };

  const approve = async (authority: OwnerAuthority, command: ApprovalCommand): Promise<ApprovalResult> => {
    if (defect !== 'cross_owner_release' && authority.ownerId !== owner.ownerId) return { ok: false, code: 'forbidden' };
    if (command.bindingId !== binding.bindingId) return { ok: false, code: 'forbidden' };
    const previous = commands.get(command.commandId);
    if (previous) {
      return sameApprovalCommandInput(previous.command, command)
        ? previous.result
        : { ok: false, code: 'idempotency_conflict' };
    }
    if (command.expectedPolicyVersion !== policyVersion) return { ok: false, code: 'stale_policy' };
    if (command.expectedBindingGeneration !== binding.generation) return { ok: false, code: 'stale_binding' };
    const items = command.selection.map(ref => inbox.find(entry => sameEventIdentity(entry.ref, ref)));
    if (items.some(item => !item || !item.decryptable)) return { ok: false, code: 'stale_content' };
    const selected = items as { ref: EventRef; payload: Uint8Array }[];

    // Stand-in payload framing: KHA-119 owns the canonical envelope codec.
    const payload = new TextEncoder().encode(JSON.stringify(selected.map(item => Buffer.from(item.payload).toString('base64'))));
    const releaseId = `rel-${owner.seed}-${command.commandId}`;
    const released = releaseFromApproval({
      approval: command,
      items: selected.map(item => item.ref),
      binding,
      policyVersion,
      release: {
        releaseId: releaseId as ReleasedJob['releaseId'],
        payloadRef: `ledger-${releaseId}`,
        payloadDigest: sha256(payload),
        causalRootId: selected[0]!.ref.eventId as unknown as ReleasedJob['causalRootId'],
      },
    });
    if (!released.ok) return { ok: false, code: released.code === 'stale_policy' ? 'stale_policy' : 'stale_content' };

    const entry: LedgerEntry = { job: released.value, payload, state: 'intent', receipts: [] };
    ledger.set(releaseId, entry);
    for (const ref of released.value.events) inbox.splice(inbox.findIndex(item => sameEventIdentity(item.ref, ref)), 1);
    record('release.intent', releaseId);
    scenario.faults.checkpoint('connector.after_intent', owner.ownerId, releaseId);

    let result: ApprovalResult = { ok: true, releaseIds: [released.value.releaseId] };
    if (!(await submit(entry))) {
      if (defect === 'repeat_submit_after_unknown') await submit(entry);
      const operationId = unwrap(decodeOperationId(`op-${owner.seed}-${++operationSequence}`), 'operationId');
      result = { ok: false, code: 'outcome_unknown', operationId };
    }
    commands.set(command.commandId, { command, result });
    return result;
  };

  const setPolicy = async (authority: OwnerAuthority, command: PolicySetCommand): Promise<PolicyAck> => {
    const ack = (connectorState: PolicyAck['connectorState'], errorCode: PolicyAck['errorCode']): PolicyAck => ({
      v: 1,
      commandId: command.commandId,
      bindingId: command.bindingId,
      generation: binding.generation,
      requestedVersion: command.expectedPolicyVersion + 1,
      effectiveVersion: errorCode === null ? policyVersion : null,
      connectorState,
      errorCode,
    });
    if (authority.ownerId !== owner.ownerId || command.bindingId !== binding.bindingId) return ack('rejected', 'forbidden');
    if (command.expectedPolicyVersion !== policyVersion) return ack('rejected', 'stale_policy');
    if (command.mode === 'auto') return ack('rejected', 'forbidden'); // G-AUTOMATION is open.
    policyVersion += 1;
    return ack('effective', null);
  };

  return {
    owner,
    approve,
    setPolicy,
    async deliver(ref, payload) {
      const deliveries = scenario.faults.checkpoint('transport.deliver_event', owner.ownerId, ref.eventId) === 'duplicate_event' ? 2 : 1;
      for (let copy = 0; copy < deliveries; copy += 1) {
        if (inbox.some(entry => sameEventIdentity(entry.ref, ref))) continue;
        const delayed = scenario.faults.checkpoint('crypto.decrypt', owner.ownerId, ref.eventId) === 'keys_delayed';
        inbox.push({ ref, payload, decryptable: !delayed });
        record('event.pending', ref.eventId);
        scenario.faults.checkpoint('connector.after_pending', owner.ownerId, ref.eventId);
      }
    },
    pending: () => inbox.filter(entry => entry.decryptable).map(entry => entry.ref),
    undecryptable: () => inbox.filter(entry => !entry.decryptable).map(entry => entry.ref),
    keysArrived() {
      scenario.faults.clear('keys_delayed', owner.ownerId);
      for (const entry of inbox) entry.decryptable = true;
    },
    async restart() {
      for (const entry of ledger.values()) {
        if (entry.state !== 'submitted') await reconcile(entry);
      }
    },
    releaseFacts: releaseId => [...new Set((ledger.get(releaseId)?.receipts ?? []).map(entry => entry.kind))],
    ingestReceipts(receipts) {
      const ordered = [...receipts];
      const first = ordered[0];
      if (first && scenario.faults.checkpoint('transport.deliver_receipts', owner.ownerId, first.releaseId) === 'reordered_receipt') {
        ordered.reverse();
      }
      for (const entry of ordered) {
        const target = ledger.get(entry.releaseId);
        if (!target || entry.bindingId !== binding.bindingId || entry.generation !== binding.generation) continue;
        target.receipts.push(entry);
      }
    },
    policyVersion: () => policyVersion,
  };
}

/** Rethrows anything that is not the named injected crash. */
export async function expectCrash(action: Promise<unknown>): Promise<InjectedCrash> {
  try {
    await action;
  } catch (error) {
    if (error instanceof InjectedCrash) return error;
    throw error;
  }
  throw new Error('expected an injected crash');
}
