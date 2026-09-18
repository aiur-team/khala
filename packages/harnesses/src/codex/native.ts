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
  /**
   * The absolute working directory the host started the executor in. KHA-104 proved the
   * route only for a thread whose native `cwd` is this directory, with no cwd override.
   */
  workdir: string;
  /** `codex --version` of the binary the host launched. */
  cliVersion: string;
  /**
   * The host's report that its executor holds the thread's native writer lock now. The
   * adapter cannot see the lock; the only native signal it checks is `notLoaded`.
   */
  holdsWriter: boolean;
}>;

export interface CodexHostPort {
  lookup(binding: SessionBinding): Promise<CodexHost | null>;
}

/**
 * Deadlines in milliseconds. `callMs` bounds each port call: host lookup, connect,
 * every request, the codec, the evidence sink and a connection close. `closeMs` bounds
 * how long `close()` waits for in-flight work. There is no default.
 */
export type CodexDeadlines = Readonly<{ callMs: number; closeMs: number }>;

/**
 * Settles with `work`, or with `fallback` once `ms` pass first. A late result is
 * dropped and a late rejection is swallowed.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Holds a connection to a no-throw, bounded contract. A request that throws or overruns
 * its deadline is a loss whose write was not seen to flush. A failed or overdue close is
 * ignored. No port defect can turn an uncertain send into an exception a caller might
 * retry, or claim a write nobody observed.
 */
export function guardConnection(connection: CodexConnection, deadlines: CodexDeadlines): CodexConnection {
  const overdue: CodexRequestOutcome = { status: 'lost', written: false, cause: 'timeout' };
  return {
    async request(method, params) {
      try {
        return await withDeadline(connection.request(method, params), deadlines.callMs, overdue);
      } catch {
        return { status: 'lost', written: false, cause: 'disconnected' };
      }
    },
    async close() {
      try {
        await withDeadline(connection.close(), deadlines.callMs, undefined);
      } catch {
        // Closing is best effort; the outcome was already decided.
      }
    },
  };
}

export type ThreadStatus = 'notLoaded' | 'idle' | 'active' | 'systemError';

/** What `thread/read {includeTurns:false}` returns. The adapter never reads history. */
export type NativeThread = Readonly<{ id: string; status: ThreadStatus; cwd: string }>;

export type QueuedSubmission = Readonly<{ id: string; clientUserMessageId: string }>;

const THREAD_STATUSES: readonly ThreadStatus[] = ['notLoaded', 'idle', 'active', 'systemError'];

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** `ThreadReadResponse.thread`; null when malformed. */
export function readThread(result: unknown): NativeThread | null {
  if (!isRecord(result) || !isRecord(result.thread)) return null;
  const { id, status, cwd } = result.thread;
  if (!isString(id) || !isString(cwd)) return null;
  if (!isRecord(status) || !THREAD_STATUSES.includes(status.type as ThreadStatus)) return null;
  return { id, status: status.type as ThreadStatus, cwd };
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
