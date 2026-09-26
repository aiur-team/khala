// Dispatch values and injected ports. The dispatcher imports contracts only: the ledger,
// approvals, payload store, codec, harness, boundary and clock are all supplied by composition (KHA-133).

import type {
  ApprovalCommand, AuthorizationId, BindingId, CausalRootId, CommandId, DeliveryReceiptTransport, HarnessPort,
  ListeningMode, OwnerAuthority, ReleaseId, ReleasedJob, SessionBinding, UnverifiedReleasedJob,
} from '@khala/contracts/delivery/index';

/**
 * The binding's applied listening-mode projection. `version` is the listening-mode control version,
 * independent of the policy version. `effective` is the listening-mode store's derivation from the
 * exact route's capabilities and grants, and `evidenceRevision` names the capability evidence it was
 * derived from. `evidenceRevision` is null exactly when `effective` is null.
 */
export type DispatchListening = Readonly<{
  version: number;
  requested: ListeningMode;
  effective: ListeningMode | null;
  evidenceRevision: string | null;
}>;

/**
 * The dispatch share of the approved local automation profile, injected by composition and never
 * read from a binding's policy. Automatic release alone enforces `maxCausalDepth`, so it is not part
 * of this value. `maxJobsPerCausalRoot` counts dispatch attempts; it is not a token or spend cap.
 */
export type DispatchLimits = Readonly<{
  maxJobsPerCausalRoot: number;
  maxConcurrentJobs: number;
  /** What to do when the bound session already has active work. */
  busy: 'queue' | 'wait' | 'reject';
}>;

/**
 * Candidate controls for one binding. It carries no limits: those come only from the injected
 * `DispatchLimits`, and a policy carrying a limit field is unusable. A missing or malformed policy
 * blocks every claim on its binding.
 */
export type DispatchPolicy = Readonly<{
  /**
   * The binding's effective policy version (`PolicyAck.effectiveVersion`). Every policy revision
   * bumps it, including a pause or a resume.
   */
  version: number;
  /**
   * The version of the newest effective revision that changed the binding's `mode`,
   * `peerParticipantId` or generation. A release is current only when
   * `armedAt <= policyVersion <= version`, so a re-arm invalidates older releases and a pause or
   * resume does not.
   */
  armedAt: number;
  paused: boolean;
  /** UTC timestamp after which no new claim is made, or null for no expiry. */
  expiresAt: string | null;
  /** Only an effective `steer` or `sync` equal to the requested mode may claim. */
  listening: DispatchListening;
}>;

export type BindingState = Readonly<{ binding: SessionBinding; revoked: boolean }>;

export type DispatchState =
  | 'queued'
  /** Budget reserved and route snapshotted, waiting at the proved boundary. No effect has run. */
  | 'claimed'
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
export const ACTIVE_STATES: readonly DispatchState[] = ['claimed', 'dispatching', 'accepted', 'outcome_unknown'];

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
  | 'harness_unsupported'
  /** Effective `async`: the agent pulls its releases, so dispatch holds them silently. */
  | 'mode_async'
  /** No effective mode, or an effective mode that differs from the requested one. */
  | 'mode_unavailable'
  /** The claimed route, evidence, harness or session changed before the boundary. */
  | 'route_drift'
  /** The proved boundary was not observed, failed, or was cancelled. */
  | 'boundary_unavailable'
  /** The release exceeds the boundary's event or byte limit. */
  | 'boundary_limit';

export type QuarantineCode =
  | 'approval_missing'
  | 'approval_mismatch'
  | 'release_invalid'
  | 'payload_missing'
  | 'payload_invalid'
  | 'payload_digest_mismatch';

/** Modes a dispatcher delivers. `async` releases are pulled by the agent and never dispatched. */
export type DispatchMode = Extract<ListeningMode, 'steer' | 'sync'>;

/**
 * The exact route identity a scheduler claim was made for. Every field is revalidated immediately
 * before delivery; a mode change after the claim does not rewrite it.
 */
export type AttemptSnapshot = Readonly<{
  modeAtClaim: DispatchMode;
  bindingGeneration: number;
  sessionId: string;
  harness: string;
  harnessVersion: string;
  adapterVersion: string;
  route: string;
  evidenceRevision: string;
}>;

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
  receipts: readonly DeliveryReceiptTransport[];
  /** The owner authorization that abandoned an unknown outcome, else null. */
  abandonedBy: AuthorizationId | null;
  /**
   * The route this attempt was claimed for. Null while queued, and for records claimed before
   * listening modes, which are never delivered again and advance only through receipts.
   */
  snapshot: AttemptSnapshot | null;
  /**
   * Whether this release already holds its one causal reservation. A claim returned to `queued`
   * before any effect keeps it, so a later claim does not reserve again.
   */
  reserved: boolean;
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

/** What a proved boundary reports about the route it is about to deliver into. */
export type BoundaryObservation = Readonly<{
  /** The interactive session the boundary belongs to. */
  binding: SessionBinding;
  /** Current capability evidence for that route. The dispatcher decodes it before use. */
  capabilities: unknown;
}>;

/**
 * Harness-neutral proved-boundary callback, supplied by the route's trusted integration. It resolves
 * when the claimed attempt's route reaches a safe delivery boundary, or with null when that boundary
 * cannot be observed. It delivers nothing itself. The dispatcher aborts `signal` on stop; any exit
 * before resolution returns the release to pending with its one reservation intact.
 *
 * `signal` only ends the wait. An integration must never use it, or anything else here, to
 * interrupt, signal or kill the user's CLI: stop revokes delivery and leaves the agent running
 * (decision 36).
 */
export interface DeliveryBoundary {
  await(input: Readonly<{
    job: ReleasedJob;
    snapshot: AttemptSnapshot;
    signal: AbortSignal;
  }>): Promise<BoundaryObservation | null>;
}

/**
 * A content-free wake for an idle session, supplied by the route's trusted integration. It is given
 * only the binding and the mode the ledger's controls allow; it never receives the release or its
 * payload, and a failure changes nothing about the persisted release (the agent still receives it at
 * its next turn).
 */
export interface IdleWake {
  wake(binding: SessionBinding, mode: 'steer' | 'sync'): Promise<void>;
}

export type DispatchDeps = Readonly<{
  ledger: DispatchLedger;
  /** The approved local profile's job, concurrency and busy limits. Invalid limits refuse construction. */
  limits: DispatchLimits;
  harness: HarnessPort;
  boundary: DeliveryBoundary;
  /** Called once per arrival that passes the wake controls, after the release is stored. Optional. */
  idleWake?: IdleWake;
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
  /**
   * First retry delay for a release returned to pending at its boundary (route drift, boundary
   * unavailable or over its limits). Doubles per consecutive miss up to a minute. Defaults to 1000.
   */
  retryDelayMs?: number;
  /** Explicit opt-in for the unproven agent-installed listener fallback. Defaults to false. */
  allowExperimentalAgentListener?: boolean;
  /** Called with an error a background pass could not handle; the job stays as persisted. */
  onError?: (error: unknown) => void;
}>;

export type ClaimResult =
  | Readonly<{ kind: 'claimed'; attemptId: string; job: ReleasedJob; snapshot: AttemptSnapshot }>
  | Readonly<{ kind: 'blocked'; code: BlockCode }>;

export type EnqueueResult = 'queued' | 'duplicate' | 'conflict';

export interface Dispatcher {
  /**
   * Stores a release for dispatch. The same release ID with other content, or another release of
   * an approval that already has one, is a conflict. Arrival wakes the dispatcher only for an
   * unpaused binding whose effective mode is `steer` or `sync`.
   */
  enqueue(job: UnverifiedReleasedJob): Promise<EnqueueResult>;
  /**
   * Starts a pass over the queue, such as after a resume. Repeated wakes coalesce into at most one
   * further pass, and a wake never resets or refunds a causal reservation.
   */
  wake(): void;
  /** Settles when no pass, boundary wait or submission started by this instance is running. */
  idle(): Promise<void>;
  /** Decodes and records a later correlated observation, such as `completed`. */
  observe(receipt: unknown): Promise<boolean>;
  /**
   * Resolves an unfinished intent from native evidence; never resubmits. A scheduler claim that no
   * boundary wait in this instance holds had no effect, so it returns to pending.
   */
  reconcile(releaseId: string): Promise<void>;
  /**
   * Ends an unknown outcome on the authority of the binding's owner, and records that
   * authorization. It frees the slot but refunds nothing. Any other authority is refused.
   */
  abandon(authority: OwnerAuthority, releaseId: string): Promise<boolean>;
  stop(): Promise<void>;
}
