// U2: send exactly the released bytes to the Khala-hosted thread, once per call.
// The payload travels only inside the `thread/queue/add` request body: never in
// process arguments, receipts, logs or errors.

import { createHash } from 'node:crypto';
import {
  type DeliveryLimits, type DeliveryReceipt, type ReceiptErrorCode, type ReleasedJob, type ReleaseId,
  validatePayloadBytes,
} from '@khala/contracts/delivery/index';
import { type ProbeDeps, probeBinding, probeErrorCode } from './capabilities';
import { type CodexConnection, readQueueAdd, withDeadline } from './native';
import { locateInQueue, queuedReceipt } from './reconcile';
import { type Clock, EVIDENCE, type EvidenceSink, makeReceipt, recordQuietly } from './receipts';

/**
 * The released envelope codec (KHA-119). It must check the payload digest and that
 * the bytes carry exactly the job's approved event references, in order.
 */
export interface ReleaseCodecPort {
  verify(job: ReleasedJob, payload: Uint8Array): Promise<'ok' | 'digest_mismatch' | 'event_mismatch'>;
}

export type SubmitDeps = ProbeDeps & Readonly<{
  codec: ReleaseCodecPort;
  clock: Clock;
  evidence: EvidenceSink;
  limits: DeliveryLimits;
}>;

/**
 * Releases whose `queue/add` may have reached the listener in this process. A later
 * submit of one of them never adds again. This is memory only: after a restart the
 * durable claim (KHA-121) is what prevents a resend, not this set.
 */
export type AttemptedReleases = Set<ReleaseId>;

// `ignoreBOM: true` keeps a leading BOM as text rather than stripping it, so the bytes
// sent re-encode to exactly the released bytes.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function submitRelease(
  deps: SubmitDeps,
  attempted: AttemptedReleases,
  job: ReleasedJob,
  payload: Uint8Array,
): Promise<DeliveryReceipt> {
  const target = { releaseId: job.releaseId, binding: job.binding };
  const failed = (errorCode: ReceiptErrorCode) =>
    makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode });

  const bytes = validatePayloadBytes(payload, deps.limits);
  if (!bytes.ok) return failed(bytes.code === 'limit_exceeded' ? 'limit_exceeded' : 'payload_digest_mismatch');
  const digest = `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`;
  if (digest !== job.payloadDigest) return failed('payload_digest_mismatch');
  let verdict: Awaited<ReturnType<ReleaseCodecPort['verify']>> | 'error';
  try {
    verdict = await withDeadline(deps.codec.verify(job, bytes.value), deps.deadlines.callMs, 'error' as const);
  } catch {
    verdict = 'error';
  }
  // Unverifiable bytes are refused like mismatched ones: only approved content is sent.
  if (verdict !== 'ok') return failed('payload_digest_mismatch');
  let text: string;
  try {
    text = decoder.decode(bytes.value);
  } catch {
    return failed('harness_rejected');
  }

  const probe = await probeBinding(job.binding, deps);
  if (!probe.ok) return failed(probeErrorCode(probe.reason));
  const { connection } = probe;
  try {
    return await enqueue(deps, attempted, connection, job, text);
  } finally {
    await connection.close();
  }
}

async function enqueue(
  deps: SubmitDeps,
  attempted: AttemptedReleases,
  connection: CodexConnection,
  job: ReleasedJob,
  text: string,
): Promise<DeliveryReceipt> {
  const target = { releaseId: job.releaseId, binding: job.binding };
  const threadId = job.binding.sessionId;
  const unknown = (errorCode?: ReceiptErrorCode, source: 'connector' | 'harness' = 'connector') =>
    makeReceipt(target, 'outcome_unknown', deps.clock, errorCode ? { source, errorCode } : { source });

  // Defence in depth behind the durable claim (KHA-121): a release still in the native
  // queue is reported, not sent again. An unreadable queue is refused before any send.
  // A consumed release has left the queue, so absence proves nothing about the past.
  const located = await locateInQueue(connection, threadId, job.releaseId);
  if (located === 'unobservable') {
    return makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode: 'harness_unavailable' });
  }
  if (located === 'queued') return queuedReceipt(job, deps.clock);
  // Already attempted in this process and no longer queued: it may have been consumed.
  if (attempted.has(job.releaseId)) return unknown();

  attempted.add(job.releaseId);
  const outcome = await connection.request('thread/queue/add', {
    threadId,
    clientUserMessageId: job.releaseId,
    input: [{ type: 'text', text, text_elements: [] }],
  });
  if (outcome.status === 'not_sent') {
    // No byte reached the transport, so a later attempt cannot duplicate this one.
    attempted.delete(job.releaseId);
    return makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode: 'harness_unavailable' });
  }

  // A native reply of either kind proves the listener read the request.
  const written = outcome.status !== 'lost' || outcome.written;
  if (written) {
    await recordQuietly(
      deps.evidence, makeReceipt(target, 'transport_written', deps.clock, { source: 'connector' }), deps.deadlines.callMs,
    );
  }

  switch (outcome.status) {
    case 'remote_error':
      // KHA-104 observed no native error from `queue/add`, so a refusal is not proof
      // that nothing was queued. It stays uncertain; the layer above must not re-release.
      return unknown('harness_rejected', 'harness');
    case 'lost':
      return unknown(outcome.cause === 'timeout' ? 'timeout' : 'disconnected');
    case 'response': {
      const queued = readQueueAdd(outcome.result);
      // A malformed or uncorrelated reply may still follow a native enqueue.
      if (!queued || queued.clientUserMessageId !== job.releaseId) return unknown();
      const receipt = makeReceipt(target, 'harness_queued', deps.clock, { source: 'harness', evidenceRef: EVIDENCE.queued });
      await recordQuietly(deps.evidence, receipt, deps.deadlines.callMs);
      return receipt;
    }
  }
}
