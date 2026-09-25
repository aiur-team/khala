// Test doubles for dispatch. Test-only: not exported from `index.ts`, and production code may not
// import from `fixtures/`. A "restart" is a new dispatcher over the
// same ledger; a "crash" is a ledger or harness call that throws at a chosen boundary.

import { createHash } from 'node:crypto';
import {
  type ApprovalCommand, type AuthorizationId, type BindingId, type CausalRootId, type CommandId, type DeliveryReceipt,
  type DeliveryReceiptV2, type EventRef, type HarnessCapabilities, type HarnessPort, type ListeningMode,
  type ModeSupport, type ModeSupportMap, type OwnerAuthority, type ReceiptKind, type ReleasedJob, type SessionBinding,
  type UnverifiedReleasedJob, decodeDeliveryLimits, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { queuedRecord } from '../claim';
import { createMemoryLedger, type MemoryLedger } from './memory-ledger';
import { createDispatcher } from '../run';
import type {
  AttemptSnapshot, BoundaryObservation, DeliveryBoundary, DispatchDeps, DispatchLedger, DispatchListening,
  DispatchPolicy, Dispatcher,
} from '../types';

export const POLICY_VERSION = 3;
export const HARNESS_VERSION = '0.154.0';
export const EVIDENCE_REVISION = 'evidence-rev-1';

/** An applied listening-mode projection with `requested === effective`. */
export function listening(
  mode: ListeningMode | null = 'sync',
  overrides: Partial<DispatchListening> = {},
): DispatchListening {
  return {
    version: 1,
    requested: mode ?? 'sync',
    effective: mode,
    evidenceRevision: mode === null ? null : EVIDENCE_REVISION,
    ...overrides,
  };
}

/** Explicit test controls. These are fixture values, not product defaults. */
export function testPolicy(overrides: Partial<DispatchPolicy> = {}): DispatchPolicy {
  return {
    version: POLICY_VERSION,
    armedAt: POLICY_VERSION,
    paused: false,
    maxJobsPerCausalRoot: 10,
    maxConcurrentJobs: 10,
    expiresAt: null,
    busy: 'queue',
    listening: listening(),
    ...overrides,
  };
}

/** Proven support for every mode on the fixture's exact interactive route. */
export function provenModes(overrides: Partial<Record<ListeningMode, Partial<ModeSupport>>> = {}): ModeSupportMap {
  const support = (mode: ListeningMode): ModeSupport => ({
    status: 'proven',
    route: `test-codex-interactive-${mode}`,
    testedVersion: HARNESS_VERSION,
    evidenceRef: `docs/evidence/codex-${mode}.md`,
    evidenceRevision: EVIDENCE_REVISION,
    reason: null,
    ...overrides[mode],
  } as ModeSupport);
  return { steer: support('steer'), sync: support('sync'), async: support('async') };
}

export const OWNER = 'owner-b' as SessionBinding['ownerId'];

/** Owner authority as trusted composition would construct it after authenticating the owner. */
export function ownerAuthority(overrides: Partial<OwnerAuthority> = {}): OwnerAuthority {
  return {
    ownerId: OWNER,
    issuer: 'https://id.example.test',
    subject: 'owner-b-subject',
    authenticatedAt: '2026-09-18T00:30:00Z',
    authorizationId: 'authz-abandon-1' as AuthorizationId,
    ...overrides,
  };
}

export function binding(id: string, generation = 0): SessionBinding {
  return {
    v: 1,
    bindingId: id as BindingId,
    ownerId: OWNER,
    agentParticipantId: `agent-${id}` as SessionBinding['agentParticipantId'],
    deviceId: 'dev-b' as SessionBinding['deviceId'],
    harness: 'codex',
    sessionId: `thread-${id}`,
    generation,
  };
}

export const sha256 = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export type Release = Readonly<{ job: ReleasedJob; approval: ApprovalCommand; payload: Uint8Array }>;

let eventCounter = 0;

/** A release built through the contract constructor, with its approval and exact payload. */
export function makeRelease(input: Readonly<{
  releaseId: string;
  bindingId?: string;
  root?: string;
  generation?: number;
  policyVersion?: number;
  payload?: Uint8Array;
}>): Release {
  const policyVersion = input.policyVersion ?? POLICY_VERSION;
  const bound = binding(input.bindingId ?? 'bind-1', input.generation ?? 0);
  const event: EventRef = {
    v: 1,
    roomId: 'room-1' as EventRef['roomId'],
    eventId: `event-${++eventCounter}` as EventRef['eventId'],
    authorParticipantId: 'agent-a' as EventRef['authorParticipantId'],
    authorDeviceId: 'dev-a' as EventRef['authorDeviceId'],
    contentDigest: `sha256:${'b'.repeat(64)}`,
  };
  const approval: ApprovalCommand = {
    v: 1,
    commandId: `approve-${input.releaseId}` as CommandId,
    roomId: event.roomId,
    bindingId: bound.bindingId,
    expectedPolicyVersion: policyVersion,
    expectedBindingGeneration: bound.generation,
    selection: [event],
    issuedAt: '2026-09-18T00:00:00Z',
  };
  const payload = input.payload ?? new TextEncoder().encode(`payload for ${input.releaseId}`);
  const released = releaseFromApproval({
    approval,
    items: [event],
    binding: bound,
    policyVersion,
    release: {
      releaseId: input.releaseId as ReleasedJob['releaseId'],
      payloadRef: `ledger-${input.releaseId}`,
      payloadDigest: sha256(payload),
      causalRootId: (input.root ?? 'cause-1') as CausalRootId,
    },
  });
  if (!released.ok) throw new Error(`fixture release rejected: ${released.code}`);
  return { job: released.value, approval, payload };
}

export function receipt(job: UnverifiedReleasedJob, kind: ReceiptKind, extra: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    v: 1,
    receiptId: `receipt-${job.releaseId}-${kind}` as DeliveryReceipt['receiptId'],
    releaseId: job.releaseId,
    bindingId: job.binding.bindingId,
    generation: job.binding.generation,
    kind,
    observedAt: '2026-09-18T02:38:00.125Z',
    source: 'harness',
    evidenceRef: `codex:userMessage:${job.releaseId}`,
    errorCode: kind === 'failed' ? 'harness_rejected' : null,
    ...extra,
  };
}

type AgentAcknowledgement = Extract<DeliveryReceiptV2, { kind: 'agent_acknowledged' }>;

export function agentAcknowledgement(
  job: UnverifiedReleasedJob,
  extra: Partial<AgentAcknowledgement> = {},
): AgentAcknowledgement {
  return {
    v: 2,
    receiptId: `receipt-${job.releaseId}-agent-acknowledged` as AgentAcknowledgement['receiptId'],
    releaseId: job.releaseId,
    bindingId: job.binding.bindingId,
    generation: job.binding.generation,
    kind: 'agent_acknowledged',
    observedAt: '2026-09-18T02:38:01.125Z',
    source: 'agent',
    evidenceRef: `ack:${job.releaseId}`,
    errorCode: null,
    ...extra,
  };
}

export const MAX_PAYLOAD_BYTES = 4096;

const LIMITS = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 50, maxPayloadBytes: MAX_PAYLOAD_BYTES });
  if (!decoded.ok) throw new Error('fixture limits rejected');
  return decoded.value;
})();

export function capabilities(
  busy: HarnessCapabilities['busy'] = 'queue',
  overrides: Partial<HarnessCapabilities> = {},
): HarnessCapabilities {
  return {
    v: 3,
    harness: 'codex',
    version: '0.154.0',
    adapterVersion: 'test-adapter',
    support: 'tested',
    existingSession: 'khala_hosted_resume',
    immediateNotification: 'khala_hosted_idle',
    busy,
    receiptEvidence: ['harness_queued', 'completed', 'outcome_unknown', 'failed'],
    reconcileByReleaseId: 'while_queued',
    limits: LIMITS,
    evidenceRef: 'docs/evidence/codex.md',
    modes: provenModes(),
    acknowledgement: 'batch_token_next_call',
    ...overrides,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export type SubmitBehavior = (job: ReleasedJob) => Promise<DeliveryReceipt>;

/** Harness double. Every submit is recorded; the default accepts with `harness_queued`. */
export class FakeHarness implements HarnessPort {
  readonly submitted: Array<Readonly<{ job: ReleasedJob; payload: Uint8Array }>> = [];
  busy: HarnessCapabilities['busy'] = 'queue';
  /** Replaces fields of the reported capabilities, or the whole report when it is not an object. */
  route: Partial<HarnessCapabilities> | null = {};
  inspected = 0;
  onSubmit: SubmitBehavior = async job => receipt(job, 'harness_queued');
  onReconcile: (job: ReleasedJob) => Promise<DeliveryReceipt | null> = async () => null;

  async inspect(): Promise<HarnessCapabilities> {
    this.inspected += 1;
    return (this.route === null ? null : capabilities(this.busy, this.route)) as HarnessCapabilities;
  }
  async notify(): Promise<void> {}
  async submit(input: Readonly<{ job: ReleasedJob; payload: Uint8Array }>): Promise<DeliveryReceipt> {
    this.submitted.push(input);
    return this.onSubmit(input.job);
  }
  async reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null> { return this.onReconcile(job); }
  async close(): Promise<void> {}

  submittedIds(): string[] { return this.submitted.map(entry => entry.job.releaseId); }
}

export type BoundaryCall = Readonly<{ job: ReleasedJob; snapshot: AttemptSnapshot; signal: AbortSignal }>;

/**
 * Proved-boundary double. By default the boundary is reached at once, reporting the claimed session
 * and the harness's current capabilities without counting as a harness inspection.
 */
export class FakeBoundary implements DeliveryBoundary {
  readonly calls: BoundaryCall[] = [];
  onAwait: (call: BoundaryCall) => Promise<BoundaryObservation | null>;

  constructor(harness: FakeHarness) {
    this.onAwait = async ({ job }) => ({
      binding: job.binding,
      capabilities: harness.route === null ? null : capabilities(harness.busy, harness.route),
    });
  }

  async await(call: BoundaryCall): Promise<BoundaryObservation | null> {
    this.calls.push(call);
    return this.onAwait(call);
  }
}

/** Wraps a ledger so chosen transactions throw before or after they commit. */
export function faultyLedger(inner: DispatchLedger): DispatchLedger & { crashAt(n: number, when: 'before' | 'after'): void; count: number } {
  const crashes = new Map<number, 'before' | 'after'>();
  const ledger = {
    count: 0,
    crashAt(n: number, when: 'before' | 'after') { crashes.set(n, when); },
    async transact<T>(work: Parameters<DispatchLedger['transact']>[0]): Promise<T> {
      const index = ++ledger.count;
      if (crashes.get(index) === 'before') throw new Error('crash before commit');
      const result = await inner.transact(work) as T;
      if (crashes.get(index) === 'after') throw new Error('crash after commit');
      return result;
    },
  };
  return ledger;
}

export type World = {
  ledger: MemoryLedger;
  harness: FakeHarness;
  boundary: FakeBoundary;
  releases: Map<string, Release>;
  errors: unknown[];
  now: Date;
  /** Payload refs read, with the byte limit each read was given. */
  reads: Array<Readonly<{ ref: string; maxBytes: number }>>;
  /** Approval command IDs looked up, in order. */
  lookups: string[];
  /** Runs inside each approval lookup, before it returns. */
  onApproval: (commandId: string) => Promise<void> | void;
  add(release: Release): Release;
  /** Sets the effective policy of every binding. */
  setPolicy(policy: DispatchPolicy | null): Promise<void>;
  dispatcher(overrides?: Partial<DispatchDeps>): Dispatcher;
};

export async function world(policy: DispatchPolicy | null = testPolicy(), bindingIds = ['bind-1', 'bind-2', 'bind-3']): Promise<World> {
  const ledger = createMemoryLedger();
  await ledger.transact(tx => {
    for (const id of bindingIds) {
      tx.setBinding({ binding: binding(id), revoked: false });
      tx.setPolicy(id as BindingId, policy);
    }
  });
  const releases = new Map<string, Release>();
  const approvals = new Map<string, ApprovalCommand>();
  const payloads = new Map<string, Uint8Array>();
  let ids = 0;
  const harness = new FakeHarness();
  const state: World = {
    ledger,
    harness,
    boundary: new FakeBoundary(harness),
    releases,
    errors: [],
    now: new Date('2026-09-18T01:00:00Z'),
    reads: [],
    lookups: [],
    onApproval: () => undefined,
    setPolicy: next => ledger.transact(tx => {
      for (const id of bindingIds) tx.setPolicy(id as BindingId, next);
    }),
    add(release) {
      releases.set(release.job.releaseId, release);
      approvals.set(release.approval.commandId, release.approval);
      payloads.set(release.job.payloadRef, release.payload);
      return release;
    },
    dispatcher(overrides = {}) {
      return createDispatcher({
        ledger,
        harness: state.harness,
        boundary: state.boundary,
        approvals: {
          get: async id => {
            state.lookups.push(id);
            await state.onApproval(id);
            return approvals.get(id) ?? null;
          },
        },
        payloads: {
          read: async (ref, maxBytes) => {
            state.reads.push({ ref, maxBytes });
            return payloads.get(ref)?.subarray(0, maxBytes + 1) ?? null;
          },
        },
        digest: async bytes => sha256(bytes),
        clock: { now: () => state.now },
        newId: kind => `${kind}-${++ids}`,
        workerId: 'worker-1',
        onError: error => void state.errors.push(error),
        ...overrides,
      });
    },
  };
  return state;
}

/** Queues a release directly in the ledger, without waking any dispatcher. */
export const seed = (ledger: DispatchLedger, job: UnverifiedReleasedJob) =>
  ledger.transact(tx => tx.put(queuedRecord(job, tx.nextSeq())));

export const recordOf = (ledger: DispatchLedger, releaseId: string) =>
  ledger.transact(tx => tx.record(releaseId as ReleasedJob['releaseId']));
