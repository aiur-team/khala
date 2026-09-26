// Acceptance 2, the live runner (docs/product/internal-mode/acceptance.md, AC3).
//
// Every outside effect is a port, so the orchestration in `runner.ts` and the
// verdict in `verify.ts` run unchanged against the offline fakes in
// `tests/e2e/acceptance/`. The runner starts the local server and nothing else:
// the normal Aiur Executor starts each agent CLI, and Khala never launches,
// wraps or signals one (executor decisions 24 and 36).

import type { HarnessCapabilities } from '../../packages/contracts/src/delivery/harness';
import type { ListeningMode } from '../../packages/contracts/src/delivery/listening-mode';

export const ACCEPTANCE_REPOSITORY = 'aiur-team/khala';
export const ACCEPTANCE_LABEL = 'acceptance';

export type RoleName = 'a' | 'b';

export type ProfileRole = Readonly<{
  role: RoleName;
  /** Native harness the Executor's CLI session runs: `claude`, `codex`, `opencode`. */
  harness: string;
  /** Provider and model the durable Aiur evidence must name, e.g. `anthropic` / `claude-opus-5-5`. */
  provider: string;
  model: string;
  /** Labels that make the normal Executor dispatch this ticket to that harness and model. */
  labels: readonly string[];
  /** The exact route's capabilities; only its declared-supported modes are exercised. */
  capabilities: HarnessCapabilities;
}>;

export type Profile = Readonly<{
  name: string;
  repository: typeof ACCEPTANCE_REPOSITORY;
  /** Normal dispatch label, e.g. `agent:todo`. */
  dispatchLabel: string;
  /** Pinned `@aiur/khala` spec, e.g. `@aiur/khala@0.4.0`, used for `status` and the launcher. */
  khalaPackage: string;
  /** Upper bound on the whole run, from ticket creation to Stop. */
  timeoutMs: number;
  roles: readonly [ProfileRole, ProfileRole];
}>;

export type ModePlan = Readonly<{
  runnable: readonly ListeningMode[];
  /** Modes either role's route does not prove, with the reason. Never substituted. */
  skipped: readonly Readonly<{ mode: ListeningMode; reason: string }>[];
}>;

export type Markers = Readonly<{
  run: string;
  /** Posted by each role right after it connects, naming the binding it holds. */
  ready(role: RoleName): string;
  /** Role- and mode-specific handshake marker. */
  handshake(role: RoleName, mode: ListeningMode): string;
  /** A's final acknowledgement of B's marker in `mode`. */
  ack(mode: ListeningMode): string;
}>;

// ---------------------------------------------------------------------------
// GitHub

export type IssueRecord = Readonly<{
  number: number;
  repository: string;
  title: string;
  body: string;
  labels: readonly string[];
  state: 'open' | 'closed';
  createdAt: string;
}>;

export type GitHubPort = Readonly<{
  /** Confirms the repository and every label exist and the credential can write issues. */
  preflight(repository: string, labels: readonly string[]): Promise<void>;
  createIssue(input: Readonly<{ repository: string; title: string; body: string; labels: readonly string[] }>): Promise<IssueRecord>;
  getIssue(repository: string, number: number): Promise<IssueRecord>;
  closeIssue(repository: string, number: number, comment: string): Promise<void>;
  /** Pull requests linked to or mentioning the issue; acceptance tickets must have none. */
  linkedPullRequests(repository: string, number: number): Promise<readonly number[]>;
}>;

// ---------------------------------------------------------------------------
// Aiur: the Executor's own record of the CLI session it started for a ticket.

export type NativeSession = Readonly<{
  /** The harness's own session ID; the store keeps only its digest. */
  sessionId: string;
  pid: number;
  harness: string;
  provider: string;
  model: string;
  cliVersion: string;
  launchCommand: string;
  startedAt: string;
}>;

export type AiurPort = Readonly<{
  /** The durable native session the Executor recorded for the ticket, or null while none is recorded. */
  session(ticket: number): Promise<NativeSession | null>;
  /** Whether that exact process still runs as that session. Never signals it. */
  alive(session: NativeSession): Promise<boolean>;
}>;

// ---------------------------------------------------------------------------
// The local server, through `internal-launcher` and the owner's HTTP routes.

export type TimelineEvent = Readonly<{
  eventId: string;
  authorParticipantId: string;
  authorKind: string;
  body: string;
  receivedAt: string;
}>;

export type AccessRequest = Readonly<{
  requestHandle: string;
  revision: string;
  outcome: string;
  harness: string;
  sessionFingerprint: string;
}>;

export type StopTarget = Readonly<{ bindingId: string; generation: number; agentParticipantId: string }>;

export type StopReply =
  | Readonly<{ kind: 'stopped'; stopped: readonly StopTarget[] }>
  | Readonly<{ kind: 'partial'; stopped: readonly StopTarget[]; remaining: readonly StopTarget[] }>
  | Readonly<{ kind: 'refused'; status: number; code: string }>;

export type ModeRequest =
  | Readonly<{ kind: 'effective' }>
  | Readonly<{ kind: 'unsupported'; reason: string }>;

export type OwnerSession = Readonly<{
  channelId: string;
  channelUrl: string;
  timeline(): Promise<readonly TimelineEvent[]>;
  say(body: string, clientTxnId: string): Promise<string>;
  accessRequests(): Promise<readonly AccessRequest[]>;
  approve(request: AccessRequest, operationId: string): Promise<void>;
  /** Asks the binding's listening-mode control for `mode` and waits for its confirmed state. */
  requestMode(target: StopTarget, mode: ListeningMode): Promise<ModeRequest>;
  stop(targets: readonly StopTarget[]): Promise<StopReply>;
  /** The channel page and API still answer. */
  viewable(): Promise<boolean>;
}>;

export type LaunchedServer = Readonly<{
  channelId: string;
  origin: string;
  /** The human's link into the channel; printed for the controller, never stored in the report. */
  humanUrl: string;
  owner(): Promise<OwnerSession>;
  /** Closes the launcher the way Ctrl+C does; the server then stops. Idempotent. */
  close(): Promise<void>;
  /** Whether anything still answers on the origin. */
  reachable(): Promise<boolean>;
}>;

export type LauncherPort = Readonly<{
  /** `khala internal`, or `khala internal --resume <channel-id>`. Starts the server only. */
  start(resume: string | null): Promise<LaunchedServer>;
}>;

// ---------------------------------------------------------------------------
// The post-shutdown snapshot, read through the `local-sqlite-channel-store` adapter.

export type SnapshotBinding = Readonly<{
  bindingId: string;
  generation: number;
  participantId: string;
  harness: string;
  sessionDigest: string;
  status: 'active' | 'revoked';
}>;

export type SnapshotEvent = Readonly<{
  sequence: number;
  eventId: string;
  authorParticipantId: string;
  authorDeviceId: string;
  clientTxnId: string;
  receivedAt: string;
}>;

export type SnapshotReceipt = Readonly<{
  receiptId: string;
  bindingId: string;
  generation: number;
  kind: string;
  source: string;
  observedAt: string;
  eventIds: readonly string[];
}>;

export type ChannelSnapshot = Readonly<{
  channelId: string;
  bindings: readonly SnapshotBinding[];
  events: readonly SnapshotEvent[];
  receipts: readonly SnapshotReceipt[];
}>;

export type SnapshotPort = Readonly<{
  /** Refuses while a launcher still holds the channel: live SQLite is never read. */
  read(channelId: string): Promise<ChannelSnapshot>;
}>;

// ---------------------------------------------------------------------------
// The human controller at the terminal.

export type ControllerPort = Readonly<{
  /** The human confirms the one channel this run uses. */
  confirmChannel(channel: Readonly<{ channelId: string; channelUrl: string; humanUrl: string }>): Promise<boolean>;
  /** The human confirms each access grant before the runner records the approval. */
  confirmGrant(grant: Readonly<{ ticket: number; role: RoleName; harness: string; sessionFingerprint: string; verified: boolean }>): Promise<boolean>;
  note(line: string): void;
}>;

export type StatusPort = Readonly<{
  /** `npx @aiur/khala status`, parsed. The optional hardening result is recorded, never gating. */
  status(packageSpec: string): Promise<Readonly<{ ok: boolean; output: unknown }>>;
}>;

export type HostLock = Readonly<{ release(): Promise<void> }>;

export type LockPort = Readonly<{
  /** One kernel-held lock per repository on this host, or null when another run holds it. */
  acquire(repository: string): Promise<HostLock | null>;
}>;

export type Clock = Readonly<{
  now(): number;
  sleep(ms: number): Promise<void>;
}>;

export type RunnerDeps = Readonly<{
  lock: LockPort;
  status: StatusPort;
  github: GitHubPort;
  aiur: AiurPort;
  launcher: LauncherPort;
  snapshot: SnapshotPort;
  controller: ControllerPort;
  clock: Clock;
  /** Poll interval for bounded waits. */
  pollMs?: number;
}>;

// ---------------------------------------------------------------------------
// The report. Markers are never copied into it.

export type CheckStatus = 'pass' | 'fail' | 'unproven';

export type Check = Readonly<{ check: string; status: CheckStatus; detail: string }>;

export type Verdict = 'pass' | 'fail' | 'unproven' | 'refused';

export type RoleRecord = Readonly<{
  role: RoleName;
  ticket: number;
  session: NativeSession | null;
  target: StopTarget | null;
}>;

export type StopRecord = Readonly<{
  attempted: boolean;
  reply: StopReply | null;
  /** Wall-clock time the Stop request was sent; later delivery evidence fails the run. */
  at: string | null;
  refusedLocally: string | null;
  aliveBefore: readonly boolean[];
  aliveAfter: readonly boolean[];
  serverViewableAfter: boolean | null;
}>;

export type RunReport = Readonly<{
  profile: string;
  repository: string;
  verdict: Verdict;
  checks: readonly Check[];
  modes: ModePlan;
  roles: readonly RoleRecord[];
  stop: StopRecord | null;
  launcherClosed: boolean;
  cleanup: readonly Readonly<{ ticket: number; outcome: 'closed' | 'already_closed' | 'refused' | 'failed'; detail: string }>[];
  unexpectedPullRequests: readonly number[];
  errors: readonly string[];
  status: unknown;
}>;
