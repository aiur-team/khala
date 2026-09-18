// U3: find a release in native state by its correlation ID. KHA-104 showed that
// `clientUserMessageId` does not deduplicate and that a replay is executed, so a
// release that cannot be found is never permission to submit again.

import type { DeliveryReceipt, ReleasedJob, ReleaseId } from '@khala/contracts/delivery/index';
import { probeBinding } from './capabilities';
import { type CodexClientPort, type CodexConnection, type CodexHostPort, readQueuePage, readThread } from './native';
import { type Clock, EVIDENCE, makeReceipt } from './receipts';

/** Pages read before giving up; a queue longer than this is reported unobservable. */
export const MAX_QUEUE_PAGES = 20;

export type Located =
  | 'queued'
  | 'consumed'
  | 'completed'
  /** Neither pending nor consumed in this thread's history. */
  | 'absent'
  /** The native state could not be read completely. */
  | 'unobservable';

async function pendingInQueue(
  connection: CodexConnection,
  threadId: string,
  releaseId: ReleaseId,
): Promise<boolean | null> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_QUEUE_PAGES; page++) {
    const outcome = await connection.request('thread/queue/list', { threadId, cursor });
    if (outcome.status !== 'response') return null;
    const read = readQueuePage(outcome.result);
    if (!read) return null;
    if (read.data.some(entry => entry.clientUserMessageId === releaseId)) return true;
    if (read.nextCursor === null) return false;
    cursor = read.nextCursor;
  }
  return null;
}

async function consumedInHistory(
  connection: CodexConnection,
  threadId: string,
  releaseId: ReleaseId,
): Promise<'consumed' | 'completed' | 'absent' | null> {
  const outcome = await connection.request('thread/read', { threadId, includeTurns: true });
  if (outcome.status !== 'response') return null;
  const thread = readThread(outcome.result);
  if (!thread || thread.id !== threadId) return null;
  const turns = thread.turns.filter(turn => turn.userMessageClientIds.includes(releaseId));
  if (turns.length === 0) return 'absent';
  return turns.some(turn => turn.status === 'completed') ? 'completed' : 'consumed';
}

/**
 * Consumption is the stronger fact, so history is checked first. A release both
 * consumed and still queued (a duplicate entry) reports its consumption.
 */
export async function locateRelease(
  connection: CodexConnection,
  threadId: string,
  releaseId: ReleaseId,
): Promise<Located> {
  const history = await consumedInHistory(connection, threadId, releaseId);
  if (history === null) return 'unobservable';
  if (history !== 'absent') return history;
  const queued = await pendingInQueue(connection, threadId, releaseId);
  if (queued === null) return 'unobservable';
  if (queued) return 'queued';
  // The queue drains into history; re-read so a release consumed between the two
  // reads is not reported absent.
  const again = await consumedInHistory(connection, threadId, releaseId);
  if (again === null) return 'unobservable';
  return again;
}

/** The receipt for a release found in native state, or null when it was not found. */
export function locatedReceipt(job: ReleasedJob, located: Located, clock: Clock): DeliveryReceipt | null {
  const target = { releaseId: job.releaseId, binding: job.binding };
  switch (located) {
    case 'queued':
      return makeReceipt(target, 'harness_queued', clock, { source: 'harness', evidenceRef: EVIDENCE.listed });
    case 'consumed':
      return makeReceipt(target, 'context_consumed', clock, { source: 'harness', evidenceRef: EVIDENCE.consumed });
    case 'completed':
      return makeReceipt(target, 'completed', clock, { source: 'harness', evidenceRef: EVIDENCE.completed });
    default:
      return null;
  }
}

/**
 * Reports what native state shows for the release, or null when it shows nothing or
 * cannot be read. Null never authorizes another submit.
 */
export async function reconcileRelease(
  deps: Readonly<{ client: CodexClientPort; hosts: CodexHostPort; clock: Clock }>,
  job: ReleasedJob,
): Promise<DeliveryReceipt | null> {
  const probe = await probeBinding(job.binding, deps.hosts, deps.client);
  if (!probe.ok) return null;
  try {
    return locatedReceipt(job, await locateRelease(probe.connection, job.binding.sessionId, job.releaseId), deps.clock);
  } finally {
    await probe.connection.close();
  }
}
