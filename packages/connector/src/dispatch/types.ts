// Dispatch values and injected ports. The dispatcher imports contracts only: the ledger,
// approvals, payload store, codec, harness and clock are all supplied by composition (KHA-133).

import type {
  ApprovalCommand, AuthorizationId, BindingId, CausalRootId, CommandId, DeliveryReceipt, HarnessPort, OwnerAuthority,
  ReleaseId, ReleasedJob, SessionBinding, UnverifiedReleasedJob,
} from '@khala/contracts/delivery/index';

/**
 * Candidate automation controls for one binding. These are not product defaults: G-AUTOMATION
 * decides limits, budget scope and unit, reset ownership and busy behavior. A missing or malformed
 * policy blocks every claim on its binding. `maxJobsPerCausalRoot` counts dispatch attempts; it is
 * not a token or spend cap.
 */
export type DispatchPolicy = Readonly<{
  /**
   * The binding's effective policy version (`PolicyAck.effectiveVersion`). It must equal the
   * release's `policyVersion`; any other version makes the release stale.
   */
  version: number;
  paused: boolean;
  maxJobsPerCausalRoot: number;
  maxConcurrentJobs: number;
  /** UTC timestamp after which no new claim is made, or null for no expiry. */
  expiresAt: string | null;
  /** What to do when the bound session already has active work. */
  busy: 'queue' | 'wait' | 'reject';
}>;

export type BindingState = Readonly<{ binding: SessionBinding; revoked: boolean }>;

export type DispatchState =
  | 'queued'
  | 'quarantined'
  | 'rejected'
  | 'dispatching'
  | 'accepted'
  | 'outcome_unknown'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned';

/** States that hold a concurrency slot and make their binding busy. */
export const ACTIVE_STATES: readonly DispatchState[] = ['dispatching', 'accepted', 'outcome_unknown'];

export type BlockCode =
  | 'paused'
  | 'budget_exhausted'
  | 'stale_binding'
  | 'stale_policy'
  | 'revoked'
  | 'busy'
  | 'expired'
  | 'claimed_elsewhere'
  | 'unconfigured'
  | 'at_capacity'
  /** The harness route is not proven to deliver into this existing session without steering it. */
  | 'harness_unsupported';

export type QuarantineCode =
  | 'approval_missing'
  | 'approval_mismatch'
  | 'release_invalid'
  | 'payload_missing'
  | 'payload_invalid'
  | 'payload_digest_mismatch';

export type DispatchRecord = Readonly<{
  releaseId: ReleaseId;
  /** Enqueue order. */
  seq: number;
  job: UnverifiedReleasedJob;
  state: DispatchState;
  /** Why a queued job is waiting, why it was rejected or quarantined, else null. */
  reason: BlockCode | QuarantineCode | null;
  /** Stable identity of the one dispatch intent; null until claimed. */
  attemptId: string | null;
  workerId: string | null;
  claimedAt: string | null;
  /** Correlated observations, in arrival order, deduplicated by receipt ID, at most `MAX_RECEIPTS`. */
  receipts: readonly DeliveryReceipt[];
  /** The owner authorization that abandoned an unknown outcome, else null. */
  abandonedBy: AuthorizationId | null;
}>;

/** Receipts kept per record. Later distinct receipts are refused, so a record stays bounded. */
export const MAX_RECEIPTS = 32;

/**
 * One local transaction. Work runs synchronously: every read and write inside it is atomic and
 * serializable against every other transaction on the same ledger, including other processes.
 * If the work throws, nothing it wrote is committed. No external effect may run inside it.
 */
export interface DispatchTx {
  /** The effective policy the connector has applied to a binding, or null when none is configured. */
  policy(bindingId: BindingId): DispatchPolicy | null;
  binding(bindingId: BindingId): BindingState | null;
  record(releaseId: ReleaseId): DispatchRecord | null;
  /** The release already recorded for an approval, in any state, or null. */
  releaseFor(commandId: CommandId): ReleaseId | null;
  put(record: DispatchRecord): void;
  /** Queued release IDs in enqueue order. */
  queued(): readonly ReleaseId[];
  /** Records in `ACTIVE_STATES`. */
  active(): readonly DispatchRecord[];
  nextSeq(): number;
  /** Attempts reserved under a trusted causal root. Never decreases through this module. */
  causalCount(root: CausalRootId): number;
  setCausalCount(root: CausalRootId, count: number): void;
}

export interface DispatchLedger {
  transact<T>(work: (tx: DispatchTx) => T): Promise<T>;
}

export type DispatchDeps = Readonly<{
  ledger: DispatchLedger;
  harness: HarnessPort;
  /** The approval a release names, from the owner connector's own ledger. */
  approvals: Readonly<{ get(commandId: CommandId): Promise<ApprovalCommand | null> }>;
  /**
   * Owner-local payload bytes by the release's `payloadRef`. The store reads at most
   * `maxBytes + 1` bytes, so an oversized payload is detected without reading it in full.
   */
  payloads: Readonly<{ read(payloadRef: string, maxBytes: number): Promise<Uint8Array | null> }>;
  /** KHA-119 canonical payload digest (`sha256:<hex>`). */
  digest(payload: Uint8Array): Promise<string>;
  clock: Readonly<{ now(): Date }>;
  newId(kind: 'attempt' | 'receipt'): string;
  /** Identifies this dispatcher process in the records it claims. */
  workerId: string;
  /** Called with an error a background pass could not handle; the job stays as persisted. */
  onError?: (error: unknown) => void;
}>;

export type ClaimResult =
  | Readonly<{ kind: 'claimed'; attemptId: string; job: ReleasedJob }>
  | Readonly<{ kind: 'blocked'; code: BlockCode }>;

export type EnqueueResult = 'queued' | 'duplicate' | 'conflict';

export interface Dispatcher {
  /**
   * Stores a release for dispatch. The same release ID with other content, or another release of
   * an approval that already has one, is a conflict.
   */
  enqueue(job: UnverifiedReleasedJob): Promise<EnqueueResult>;
  /** Starts a pass over the queue. Repeated wakes coalesce and never reserve twice. */
  wake(): void;
  /** Settles when no pass or submission started by this instance is running. */
  idle(): Promise<void>;
  /** Decodes and records a later correlated observation, such as `completed`. */
  observe(receipt: unknown): Promise<boolean>;
  /** Resolves an unfinished intent from native evidence; never resubmits. */
  reconcile(releaseId: string): Promise<void>;
  /**
   * Ends an unknown outcome on the authority of the binding's owner, and records that
   * authorization. It frees the slot but refunds nothing. Any other authority is refused.
   */
  abandon(authority: OwnerAuthority, releaseId: string): Promise<boolean>;
  stop(): Promise<void>;
}
