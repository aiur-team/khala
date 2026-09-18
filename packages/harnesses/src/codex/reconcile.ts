// U3: find a release in the native queue by its correlation ID (`while_queued`).
// KHA-104 showed that `clientUserMessageId` does not deduplicate and that a replay is
// executed, so a release that cannot be found is never permission to submit again.
// History is not read: the proof never used `thread/read {includeTurns:true}`, and a
// trimmed or paginated history would report a consumed release as absent.
// Deduplication after consumption belongs to the connector (KHA-121).

import type { DeliveryReceipt, ReleasedJob, ReleaseId } from '@khala/contracts/delivery/index';
import { type ProbeDeps, probeBinding } from './capabilities';
import { type CodexConnection, readQueuePage } from './native';
import { type Clock, EVIDENCE, makeReceipt } from './receipts';

/** Pages read before giving up; a queue longer than this is reported unobservable. */
export const MAX_QUEUE_PAGES = 20;

export type Located =
  | 'queued'
  /** Not pending in the queue. It may never have arrived, or may have been consumed. */
  | 'absent'
  /** The queue could not be read completely. */
  | 'unobservable';

export async function locateInQueue(
  connection: CodexConnection,
  threadId: string,
  releaseId: ReleaseId,
): Promise<Located> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_QUEUE_PAGES; page++) {
    const outcome = await connection.request('thread/queue/list', { threadId, cursor });
    if (outcome.status !== 'response') return 'unobservable';
    const read = readQueuePage(outcome.result);
    if (!read) return 'unobservable';
    if (read.data.some(entry => entry.clientUserMessageId === releaseId)) return 'queued';
    if (read.nextCursor === null) return 'absent';
    cursor = read.nextCursor;
  }
  return 'unobservable';
}

export function queuedReceipt(job: ReleasedJob, clock: Clock): DeliveryReceipt {
  return makeReceipt({ releaseId: job.releaseId, binding: job.binding }, 'harness_queued', clock, {
    source: 'harness', evidenceRef: EVIDENCE.listed,
  });
}

/**
 * Reports `harness_queued` while the release is still pending in the native queue, or
 * null otherwise. Null never authorizes another submit.
 */
export async function reconcileRelease(
  deps: ProbeDeps & Readonly<{ clock: Clock }>,
  job: ReleasedJob,
): Promise<DeliveryReceipt | null> {
  const probe = await probeBinding(job.binding, deps);
  if (!probe.ok) return null;
  try {
    const located = await locateInQueue(probe.connection, job.binding.sessionId, job.releaseId);
    return located === 'queued' ? queuedReceipt(job, deps.clock) : null;
  } finally {
    await probe.connection.close();
  }
}
