// Native Codex app-server port. Wire shapes are the codex-cli 0.154.0 experimental
// schema pinned by KHA-104 (experiments/codex/evidence/schema/). The adapter reads
// every native response through these guards; anything else is malformed.

import type { SessionBinding } from '@khala/contracts/delivery/index';

/** The only listener shape KHA-104 exercised: a Unix socket speaking WebSocket JSON-RPC. */
export type CodexEndpoint = Readonly<{ kind: 'unix'; path: string }>;

/**
 * The methods this adapter may call. `thread/resume`, `turn/start`, `turn/steer` and
 * `thread/queue/delete` are deliberately absent: hosting and cleanup belong to the host
 * owner, and steering is unproven.
 */
export type CodexMethod = 'thread/read' | 'thread/queue/list' | 'thread/queue/add';

/**
 * One request's observable outcome. `not_sent` means no byte of the request reached the
 * transport; `lost` means it may have, and `written` records whether the write was seen
 * to flush.
 */
export type CodexRequestOutcome =
  | Readonly<{ status: 'response'; result: unknown }>
  | Readonly<{ status: 'remote_error'; code: number }>
  | Readonly<{ status: 'not_sent' }>
  | Readonly<{ status: 'lost'; written: boolean; cause: 'disconnected' | 'timeout' }>;

export interface CodexConnection {
  /** Must never throw; transport failures are outcomes. */
  request(method: CodexMethod, params: unknown): Promise<CodexRequestOutcome>;
  close(): Promise<void>;
}

export interface CodexClientPort {
  /**
   * Opens and initializes a connection to a Khala-hosted listener, or returns null
   * when none could be opened. Payload bytes and credentials never pass through here.
   */
  connect(endpoint: CodexEndpoint): Promise<CodexConnection | null>;
}

/**
 * A Codex executor Khala started for one binding (KHA-104 route step 1). The registry
 * lists only hosts Khala started; a thread another process runs has no entry.
 */
export type CodexHost = Readonly<{
  /** The binding the host was started for. */
  binding: SessionBinding;
  endpoint: CodexEndpoint;
  /** The listener lives in an owner-only directory and is not reachable off-host. */
  endpointPrivate: boolean;
  /** `codex --version` of the binary the host launched. */
  cliVersion: string;
  /** The native writer lock for the thread is held by this host's executor right now. */
  holdsWriter: boolean;
}>;

export interface CodexHostPort {
  lookup(binding: SessionBinding): Promise<CodexHost | null>;
}

/**
 * Holds a connection to its no-throw contract: a thrown request becomes a possibly
 * written loss, and a failed close is ignored, so no port defect can turn an
 * uncertain send into an exception a caller might retry.
 */
export function guardConnection(connection: CodexConnection): CodexConnection {
  return {
    async request(method, params) {
      try {
        return await connection.request(method, params);
      } catch {
        return { status: 'lost', written: true, cause: 'disconnected' };
      }
    },
    async close() {
      try {
        await connection.close();
      } catch {
        // Closing is best effort; the outcome was already decided.
      }
    },
  };
}

export type ThreadStatus = 'notLoaded' | 'idle' | 'active' | 'systemError';
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type NativeThread = Readonly<{
  id: string;
  status: ThreadStatus;
  turns: readonly NativeTurn[];
}>;

export type NativeTurn = Readonly<{
  id: string;
  status: TurnStatus;
  /** `clientId` of each `userMessage` item in the turn; null when the item has none. */
  userMessageClientIds: readonly (string | null)[];
}>;

export type QueuedSubmission = Readonly<{ id: string; clientUserMessageId: string }>;

const THREAD_STATUSES: readonly ThreadStatus[] = ['notLoaded', 'idle', 'active', 'systemError'];
const TURN_STATUSES: readonly TurnStatus[] = ['completed', 'interrupted', 'failed', 'inProgress'];

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** `ThreadReadResponse.thread`; null when malformed. */
export function readThread(result: unknown): NativeThread | null {
  if (!isRecord(result) || !isRecord(result.thread)) return null;
  const { id, status, turns } = result.thread;
  if (!isString(id) || !isRecord(status) || !THREAD_STATUSES.includes(status.type as ThreadStatus)) return null;
  if (!Array.isArray(turns)) return null;
  const read: NativeTurn[] = [];
  for (const turn of turns) {
    if (!isRecord(turn) || !isString(turn.id) || !TURN_STATUSES.includes(turn.status as TurnStatus)) return null;
    if (!Array.isArray(turn.items)) return null;
    const clientIds: (string | null)[] = [];
    for (const item of turn.items) {
      if (!isRecord(item) || typeof item.type !== 'string') return null;
      if (item.type !== 'userMessage') continue;
      const clientId = item.clientId ?? null;
      if (clientId !== null && typeof clientId !== 'string') return null;
      clientIds.push(clientId);
    }
    read.push({ id: turn.id, status: turn.status as TurnStatus, userMessageClientIds: clientIds });
  }
  return { id, status: status.type as ThreadStatus, turns: read };
}

export function readQueuedSubmission(value: unknown): QueuedSubmission | null {
  if (!isRecord(value) || !isString(value.id) || typeof value.clientUserMessageId !== 'string') return null;
  return { id: value.id, clientUserMessageId: value.clientUserMessageId };
}

/** `ThreadQueueAddResponse.queuedSubmission`; null when malformed. */
export function readQueueAdd(result: unknown): QueuedSubmission | null {
  return isRecord(result) ? readQueuedSubmission(result.queuedSubmission) : null;
}

/** `ThreadQueueListResponse`; null when malformed. */
export function readQueuePage(
  result: unknown,
): Readonly<{ data: readonly QueuedSubmission[]; nextCursor: string | null }> | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const nextCursor = result.nextCursor ?? null;
  if (nextCursor !== null && !isString(nextCursor)) return null;
  const data: QueuedSubmission[] = [];
  for (const entry of result.data) {
    const read = readQueuedSubmission(entry);
    if (!read) return null;
    data.push(read);
  }
  return { data, nextCursor };
}
