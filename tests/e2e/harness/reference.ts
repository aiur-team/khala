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
  decodeApprovalCommand, decodeCausalRootId, decodeDeliveryReceipt, decodeOperationId, decodeReleaseId, releaseFromApproval,
  sameApprovalCommandInput, sameEventIdentity, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { InjectedCrash, InjectedDisconnect } from './faults';
import { type OwnerFixture, nextGeneration } from './owners';
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

export type AdapterDefect =
  | 'cross_owner_release'
  | 'false_consumption'
  /** Writes into a replacement session instead of the bound existing one. */
  | 'replacement_session'
  | 'skip_digest_check'
  | 'notify_writes_content'
  /** Swallows an unconfirmed write and reports it consumed. */
  | 'unknown_reported_consumed'
  /** Retries an unconfirmed write, so the model gets it twice. */
  | 'retry_unconfirmed_write'
  /** Writes into an exited session and still reports it unavailable. */
  | 'write_after_exit'
  /** Writes into a busy session but reports the busy outcome. */
  | 'busy_leaks_write'
  /** Loses queued releases when the session becomes idle. */
  | 'busy_drops_queue'
  /** Accepts a job whose binding ID matches, whatever its generation. */
  | 'binding_id_only'
  /** Acknowledges a job for a binding it does not hold, without writing it. */
  | 'acknowledges_foreign'
  | 'always_fail'
  /** Names the next binding generation on its receipts. */
  | 'misattributed_receipt'
  | 'consumed_without_input'
  /** Hands the model bytes other than the released payload. */
  | 'rewrites_payload'
  /** Writes a payload whose digest does not match, then reports the mismatch. */
  | 'writes_rejected_payload'
  | 'reconcile_wrong_release'
  /** Queues while busy even on a route whose capabilities say reject. */
  | 'busy_ignores_route';

export interface FakeHarnessAdapter extends HarnessPort {
  /** The session finishes its turn (a busy fault ends) and takes queued releases, in order. */
  settle(): void;
  /** Receipts observed after `submit` returned, such as consumption of a queued release. */
  streamed(): readonly DeliveryReceipt[];
  /** Revocation and re-arm: the session now serves `binding` only. */
  rearm(binding: SessionBinding): void;
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
  const queued = new Map<string, ReleasedJob>();
  const streamed: DeliveryReceipt[] = [];
  const hints: string[] = [];
  let bound = owner.binding;

  const write = (job: ReleasedJob, payloadDigest = job.payloadDigest): void => {
    inputs.push({
      releaseId: job.releaseId,
      bindingId: job.binding.bindingId,
      sessionId: defect === 'replacement_session' ? `${job.binding.sessionId}-replacement` : job.binding.sessionId,
      generation: job.binding.generation,
      payloadDigest,
    });
    scenario.record('model.input', { ownerId: owner.ownerId, operationId: job.releaseId });
  };
  const holds = (binding: SessionBinding): boolean => (defect === 'binding_id_only'
    ? binding.bindingId === bound.bindingId
    : sameSessionBinding(binding, bound));

  return {
    async inspect(binding) {
      if (!sameSessionBinding(binding, bound)) throw new Error('binding is not this session');
      return capabilities;
    },
    async notify(binding, hint) {
      if (!sameSessionBinding(binding, bound)) throw new Error('binding is not this session');
      hints.push(hint.releaseId);
      if (defect === 'notify_writes_content') {
        inputs.push({ releaseId: hint.releaseId, bindingId: bound.bindingId, sessionId: bound.sessionId, generation: bound.generation, payloadDigest: 'hint' });
      }
    },
    async submit({ job, payload }) {
      if (defect === 'always_fail') return receipt(scenario, owner, job, 'failed', 'harness', 'harness_unavailable');
      if (defect !== 'cross_owner_release' && !holds(job.binding)) {
        if (defect === 'acknowledges_foreign') return receipt(scenario, owner, job, 'harness_queued', 'harness');
        return receipt(scenario, owner, job, 'failed', 'harness', 'stale_binding');
      }
      if (payload.byteLength > capabilities.limits.maxPayloadBytes) {
        return receipt(scenario, owner, job, 'failed', 'harness', 'limit_exceeded');
      }
      if (defect !== 'skip_digest_check' && sha256(payload) !== job.payloadDigest) {
        if (defect === 'writes_rejected_payload') write(job, sha256(payload));
        return receipt(scenario, owner, job, 'failed', 'harness', 'payload_digest_mismatch');
      }
      // Like a real session, this adapter does not deduplicate: a second submission
      // of a consumed release reaches the model again. Preventing that is the
      // connector's job (see the delivery contract), and the oracles must see it.
      scenario.faults.checkpoint('transport.before_write', owner.ownerId, job.releaseId);
      const accept = scenario.faults.checkpoint('harness.accept', owner.ownerId, job.releaseId);
      if (accept === 'session_exit') {
        if (defect === 'false_consumption') return receipt(scenario, owner, job, 'context_consumed', 'harness');
        if (defect === 'write_after_exit') write(job);
        return receipt(scenario, owner, job, 'failed', 'harness', 'session_unavailable');
      }
      if (accept === 'session_busy') {
        if (defect === 'busy_leaks_write') write(job);
        if (capabilities.busy !== 'queue' && defect !== 'busy_ignores_route') {
          return receipt(scenario, owner, job, 'failed', 'harness', 'busy_rejected');
        }
        queued.set(job.releaseId, job);
        return receipt(scenario, owner, job, 'harness_queued', 'harness');
      }
      if (defect === 'consumed_without_input') return receipt(scenario, owner, job, 'context_consumed', 'harness');
      if (defect === 'misattributed_receipt') {
        write(job);
        const misattributed = { ...job, binding: { ...job.binding, generation: job.binding.generation + 1 } };
        return receipt(scenario, owner, misattributed, 'context_consumed', 'harness');
      }
      write(job, sha256(defect === 'rewrites_payload' ? new TextEncoder().encode(`[khala] ${new TextDecoder().decode(payload)}`) : payload));
      try {
        scenario.faults.checkpoint('transport.after_write', owner.ownerId, job.releaseId);
      } catch (error) {
        if (!(error instanceof InjectedDisconnect)) throw error;
        if (defect === 'unknown_reported_consumed') return receipt(scenario, owner, job, 'context_consumed', 'harness');
        if (defect === 'retry_unconfirmed_write') write(job);
        throw error;
      }
      return receipt(scenario, owner, job, 'context_consumed', 'harness');
    },
    async reconcile(job) {
      if (defect === 'reconcile_wrong_release') {
        return receipt(scenario, owner, { ...job, releaseId: `${job.releaseId}-other` as ReleasedJob['releaseId'] }, 'harness_queued', 'harness');
      }
      if (inputs.some(entry => entry.releaseId === job.releaseId)) {
        return receipt(scenario, owner, job, 'context_consumed', 'harness');
      }
      if (queued.has(job.releaseId)) return receipt(scenario, owner, job, 'harness_queued', 'harness');
      return null;
    },
    async close() {
      queued.clear();
    },
    settle() {
      if (scenario.faults.isArmed('session_busy', owner.ownerId)) scenario.faults.clear('session_busy', owner.ownerId);
      if (defect !== 'busy_drops_queue') {
        for (const job of queued.values()) {
          write(job);
          streamed.push(receipt(scenario, owner, job, 'context_consumed', 'harness'));
        }
      }
      queued.clear();
    },
    streamed: () => [...streamed],
    rearm(binding) {
      bound = binding;
    },
    modelInputs: () => [...inputs],
    hints: () => [...hints],
  };
}

export type ConnectorDefect =
  | 'cross_owner_release'
  | 'repeat_submit_after_unknown'
  /** Blindly submits a release whose intent was recorded before a crash. */
  | 'resubmit_intent_on_restart'
  | 'accepts_auto'
  /** Keeps serving the old binding generation after revocation. */
  | 'ignores_revocation'
  /** Hands a pending event to the model while it is still pending. */
  | 'leak_pending'
  /** One owner's approval releases every owner's copy in the room. */
  | 'release_room_wide'
  /** One owner's approval dismisses every owner's pending copy in the room. */
  | 'dismiss_room_wide'
  | 'no_dedupe'
  | 'double_submit'
  | 'drop_undecryptable'
  | 'release_undecryptable'
  /** Loses undecryptable events when keys arrive. */
  | 'keys_lost'
  /** Keeps only the last receipt to arrive, so arrival order decides the facts. */
  | 'last_receipt_wins'
  /** Never stores delivered events. */
  | 'drops_events'
  /** Refuses another owner's authority but releases anyway. */
  | 'cross_owner_silent'
  /** Refuses even the owner's own approval. */
  | 'refuses_owner'
  /** Refuses `auto` but still advances the policy version. */
  | 'auto_bumps_version'
  /** Reports a revoked binding as stale but releases to the new generation anyway. */
  | 'revocation_leaks'
  /** Reports an unconfirmed write as a successful release. */
  | 'reports_unknown_as_ok'
  /** Forgets an unconfirmed intent on restart. */
  | 'forgets_intent';

/** The shared room that room-wide defects reach through; honest connectors ignore it. */
export type ReferenceRoom = { readonly members: Map<string, Readonly<{ release(refs: readonly EventRef[]): Promise<void>; dismiss(refs: readonly EventRef[]): void }>> };

export function createReferenceRoom(): ReferenceRoom {
  return { members: new Map() };
}

export type LedgerState = 'intent' | 'submitted' | 'unknown';

type LedgerEntry = {
  job: ReleasedJob;
  payload: Uint8Array;
  state: LedgerState;
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
  /** Revokes the current binding and re-arms the next generation of the same session. */
  revoke(): void;
  /** Observed receipt kinds for a release, as a set of facts in arrival order. */
  releaseFacts(releaseId: string): readonly ReceiptKind[];
  /** The intent ledger: every release this connector created and its settled state. */
  releases(): readonly Readonly<{ releaseId: string; state: LedgerState }>[];
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
  room?: ReferenceRoom;
}>): ReferenceConnector {
  const { scenario, owner, adapter, limits, defect, room } = input;
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
      return;
    }
    // Not found proves nothing when reconciliation only covers queued work: an intent
    // recorded before a crash becomes unknown instead of licensing a submission.
    entry.state = 'unknown';
  };

  // Receipts are facts: each is kept once by ID, whatever order they arrive in.
  const ingest = (receipts: readonly DeliveryReceipt[]): void => {
    const ordered = [...receipts];
    const first = ordered[0];
    if (first && scenario.faults.checkpoint('transport.deliver_receipts', owner.ownerId, first.releaseId) === 'reordered_receipt') {
      ordered.reverse();
    }
    for (const entry of ordered) {
      const target = ledger.get(entry.releaseId);
      if (!target || entry.bindingId !== binding.bindingId || entry.generation !== binding.generation) continue;
      if (defect === 'last_receipt_wins') target.receipts = [entry];
      else if (!target.receipts.some(known => known.receiptId === entry.receiptId)) target.receipts.push(entry);
    }
  };

  /** Releases `command.selection` from the inbox; the caller has checked authority and staleness. */
  const release = async (command: ApprovalCommand, options: Readonly<{ keepPending: boolean }>): Promise<ApprovalResult> => {
    const items = command.selection.map(ref => inbox.find(entry => sameEventIdentity(entry.ref, ref)));
    if (items.some(item => !item || (!item.decryptable && defect !== 'release_undecryptable'))) return { ok: false, code: 'stale_content' };
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
        releaseId: unwrap(decodeReleaseId(releaseId), 'releaseId'),
        payloadRef: `ledger-${releaseId}`,
        payloadDigest: sha256(payload),
        causalRootId: unwrap(decodeCausalRootId(selected[0]!.ref.eventId), 'causalRootId'),
      },
    });
    if (!released.ok) return { ok: false, code: released.code === 'stale_policy' ? 'stale_policy' : 'stale_content' };

    const entry: LedgerEntry = { job: released.value, payload, state: 'intent', receipts: [] };
    ledger.set(releaseId, entry);
    if (!options.keepPending) {
      for (const ref of released.value.events) inbox.splice(inbox.findIndex(item => sameEventIdentity(item.ref, ref)), 1);
    }
    record('release.intent', releaseId);
    scenario.faults.checkpoint('connector.after_intent', owner.ownerId, releaseId);

    if (await submit(entry)) {
      if (defect === 'double_submit') await submit(entry);
      return { ok: true, releaseIds: [released.value.releaseId] };
    }
    if (defect === 'repeat_submit_after_unknown') await submit(entry);
    if (defect === 'reports_unknown_as_ok') return { ok: true, releaseIds: [released.value.releaseId] };
    const operationId = unwrap(decodeOperationId(`op-${owner.seed}-${++operationSequence}`), 'operationId');
    return { ok: false, code: 'outcome_unknown', operationId };
  };

  /** A self-issued command, used only by the defects that bypass owner approval. */
  const selfCommand = (refs: readonly EventRef[], label: string): ApprovalCommand => unwrap(decodeApprovalCommand({
    v: 1,
    commandId: `cmd-${label}-${++operationSequence}`,
    roomId: refs[0]!.roomId,
    bindingId: binding.bindingId,
    expectedPolicyVersion: policyVersion,
    expectedBindingGeneration: binding.generation,
    selection: refs,
    issuedAt: '2026-09-18T00:00:00Z',
  }, limits), 'self-issued command');

  const approve = async (authority: OwnerAuthority, command: ApprovalCommand): Promise<ApprovalResult> => {
    if (defect === 'refuses_owner') return { ok: false, code: 'forbidden' };
    if (defect === 'cross_owner_silent' && authority.ownerId !== owner.ownerId) {
      await release(selfCommand(command.selection, 'foreign'), { keepPending: false });
      return { ok: false, code: 'forbidden' };
    }
    if (defect !== 'cross_owner_release' && authority.ownerId !== owner.ownerId) return { ok: false, code: 'forbidden' };
    if (command.bindingId !== binding.bindingId) return { ok: false, code: 'forbidden' };
    const previous = commands.get(command.commandId);
    if (previous) {
      return sameApprovalCommandInput(previous.command, command)
        ? previous.result
        : { ok: false, code: 'idempotency_conflict' };
    }
    if (command.expectedPolicyVersion !== policyVersion) return { ok: false, code: 'stale_policy' };
    if (command.expectedBindingGeneration !== binding.generation) {
      if (defect === 'revocation_leaks') await release(selfCommand(command.selection, 'revoked'), { keepPending: false });
      return { ok: false, code: 'stale_binding' };
    }
    const result = await release(command, { keepPending: false });
    commands.set(command.commandId, { command, result });
    if (result.ok && room) {
      for (const [ownerId, member] of room.members) {
        if (ownerId === owner.ownerId) continue;
        if (defect === 'release_room_wide') await member.release(command.selection);
        if (defect === 'dismiss_room_wide') member.dismiss(command.selection);
      }
    }
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
    if (command.mode === 'auto' && defect !== 'accepts_auto') { // G-AUTOMATION is open.
      if (defect === 'auto_bumps_version') policyVersion += 1;
      return ack('rejected', 'forbidden');
    }
    policyVersion += 1;
    return ack('effective', null);
  };

  const inboxed = (refs: readonly EventRef[]) => inbox.filter(entry => entry.decryptable && refs.some(ref => sameEventIdentity(ref, entry.ref)));
  room?.members.set(owner.ownerId, {
    async release(refs) {
      const held = inboxed(refs).map(entry => entry.ref);
      if (held.length > 0) await release(selfCommand(held, 'room'), { keepPending: false });
    },
    dismiss(refs) {
      for (const entry of inboxed(refs)) inbox.splice(inbox.indexOf(entry), 1);
    },
  });

  return {
    owner,
    approve,
    setPolicy,
    async deliver(ref, payload) {
      const deliveries = scenario.faults.checkpoint('transport.deliver_event', owner.ownerId, ref.eventId) === 'duplicate_event' ? 2 : 1;
      for (let copy = 0; copy < deliveries; copy += 1) {
        if (defect === 'drops_events') continue;
        if (defect !== 'no_dedupe' && inbox.some(entry => sameEventIdentity(entry.ref, ref))) continue;
        const delayed = scenario.faults.checkpoint('crypto.decrypt', owner.ownerId, ref.eventId) === 'keys_delayed';
        if (delayed && defect === 'drop_undecryptable') continue;
        inbox.push({ ref, payload, decryptable: !delayed });
        record('event.pending', ref.eventId);
        scenario.faults.checkpoint('connector.after_pending', owner.ownerId, ref.eventId);
        if (defect === 'leak_pending' && !delayed) await release(selfCommand([ref], 'leak'), { keepPending: true });
      }
    },
    pending: () => inbox.filter(entry => entry.decryptable).map(entry => entry.ref),
    undecryptable: () => inbox.filter(entry => !entry.decryptable).map(entry => entry.ref),
    keysArrived() {
      scenario.faults.clear('keys_delayed', owner.ownerId);
      for (const entry of [...inbox]) {
        if (defect === 'keys_lost' && !entry.decryptable) inbox.splice(inbox.indexOf(entry), 1);
        entry.decryptable = true;
      }
    },
    async restart() {
      for (const entry of ledger.values()) {
        if (entry.state === 'intent' && defect === 'resubmit_intent_on_restart') {
          await submit(entry);
          continue;
        }
        if (entry.state !== 'submitted') {
          await reconcile(entry);
          if (defect === 'forgets_intent' && entry.state === 'unknown') ledger.delete(entry.job.releaseId);
          continue;
        }
        // A settled release's receipts are re-read from the transport after restart.
        const current = await adapter.reconcile(entry.job);
        ingest([...entry.receipts, ...(current ? [current] : [])]);
      }
    },
    revoke() {
      if (defect !== 'ignores_revocation') binding = nextGeneration({ ...owner, binding }).binding;
    },
    releaseFacts: releaseId => [...new Set((ledger.get(releaseId)?.receipts ?? []).map(entry => entry.kind))],
    releases: () => [...ledger.entries()].map(([releaseId, entry]) => ({ releaseId, state: entry.state })),
    ingestReceipts: ingest,
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
