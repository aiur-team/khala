// Dispatch values and injected ports. The dispatcher imports contracts only: the ledger,
// approvals, payload store, codec, harness and clock are all supplied by composition (KHA-133).

import type {
  ApprovalCommand, BindingId, CausalRootId, CommandId, DeliveryReceipt, HarnessPort, ReleaseId, ReleasedJob,
  SessionBinding, UnverifiedReleasedJob,
} from '@khala/contracts/delivery/index';

/**
 * Candidate automation controls. These are not product defaults: G-AUTOMATION decides limits,
 * budget scope and unit, reset ownership and busy behavior. A missing or non-finite policy blocks
 * every claim. `maxJobsPerCausalRoot` counts dispatch attempts; it is not a token or spend cap.
 */
export type DispatchPolicy = Readonly<{
  /** Must equal the release's `policyVersion`; any other version makes the release stale. */
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
  | 'at_capacity';

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
  /** Correlated observations, in arrival order, deduplicated by receipt ID. */
  receipts: readonly DeliveryReceipt[];
}>;

/**
 * One local transaction. Work runs synchronously: every read and write inside it is atomic and
 * serializable against every other transaction on the same ledger, including other processes.
 * If the work throws, nothing it wrote is committed. No external effect may run inside it.
 */
export interface DispatchTx {
  /** The effective policy the connector has applied, or null when none is configured. */
  policy(): DispatchPolicy | null;
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
  /** Owner-local payload bytes by the release's `payloadRef`. */
  payloads: Readonly<{ read(payloadRef: string): Promise<Uint8Array | null> }>;
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
  /** Records a later correlated observation, such as `completed`. */
  observe(receipt: DeliveryReceipt): Promise<boolean>;
  /** Resolves an unfinished intent from native evidence; never resubmits. */
  reconcile(releaseId: string): Promise<void>;
  /** Owner-authorized end of an unknown outcome. It frees the slot but refunds nothing. */
  abandon(releaseId: string): Promise<boolean>;
  stop(): Promise<void>;
}
