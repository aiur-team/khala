// U2: send exactly the released bytes to the Khala-hosted thread, once per call.
// The payload travels only inside the `thread/queue/add` request body: never in
// process arguments, receipts, logs or errors.

import { createHash } from 'node:crypto';
import {
  type DeliveryLimits, type DeliveryReceipt, type ReceiptErrorCode, type ReleasedJob,
  validatePayloadBytes,
} from '@khala/contracts/delivery/index';
import { probeBinding, probeErrorCode } from './capabilities';
import { type CodexClientPort, type CodexConnection, type CodexHostPort, readQueueAdd } from './native';
import { locateRelease, locatedReceipt } from './reconcile';
import { type Clock, EVIDENCE, type EvidenceSink, makeReceipt, recordQuietly } from './receipts';

/**
 * The released envelope codec (KHA-119). It must check the payload digest and that
 * the bytes carry exactly the job's approved event references, in order.
 */
export interface ReleaseCodecPort {
  verify(job: ReleasedJob, payload: Uint8Array): Promise<'ok' | 'digest_mismatch' | 'event_mismatch'>;
}

export type SubmitDeps = Readonly<{
  client: CodexClientPort;
  hosts: CodexHostPort;
  codec: ReleaseCodecPort;
  clock: Clock;
  evidence: EvidenceSink;
  limits: DeliveryLimits;
}>;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function submitRelease(
  deps: SubmitDeps,
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
    verdict = await deps.codec.verify(job, bytes.value);
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

  const probe = await probeBinding(job.binding, deps.hosts, deps.client);
  if (!probe.ok) return failed(probeErrorCode(probe.reason));
  const { connection } = probe;
  try {
    return await enqueue(deps, connection, job, text);
  } finally {
    await connection.close();
  }
}

async function enqueue(
  deps: SubmitDeps,
  connection: CodexConnection,
  job: ReleasedJob,
  text: string,
): Promise<DeliveryReceipt> {
  const target = { releaseId: job.releaseId, binding: job.binding };
  const threadId = job.binding.sessionId;

  // Defence in depth behind the durable claim (KHA-121): a release already in native
  // state is reported, not sent again. Unreadable state is refused before any send.
  const located = await locateRelease(connection, threadId, job.releaseId);
  if (located === 'unobservable') {
    return makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode: 'harness_unavailable' });
  }
  const found = locatedReceipt(job, located, deps.clock);
  if (found) return found;

  const outcome = await connection.request('thread/queue/add', {
    threadId,
    clientUserMessageId: job.releaseId,
    input: [{ type: 'text', text, text_elements: [] }],
  });

  const written = outcome.status === 'response' || outcome.status === 'remote_error'
    || (outcome.status === 'lost' && outcome.written);
  if (written) {
    await recordQuietly(deps.evidence, makeReceipt(target, 'transport_written', deps.clock, { source: 'connector' }));
  }

  switch (outcome.status) {
    case 'not_sent':
      return makeReceipt(target, 'failed', deps.clock, { source: 'connector', errorCode: 'harness_unavailable' });
    case 'remote_error':
      // A JSON-RPC error is a native refusal of this request; nothing was queued.
      return makeReceipt(target, 'failed', deps.clock, { source: 'harness', errorCode: 'harness_rejected' });
    case 'lost':
      return makeReceipt(target, 'outcome_unknown', deps.clock, {
        source: 'connector',
        errorCode: outcome.cause === 'timeout' ? 'timeout' : 'disconnected',
      });
    case 'response': {
      const queued = readQueueAdd(outcome.result);
      // A malformed or uncorrelated reply may still follow a native enqueue.
      if (!queued || queued.clientUserMessageId !== job.releaseId) {
        return makeReceipt(target, 'outcome_unknown', deps.clock, { source: 'connector' });
      }
      const receipt = makeReceipt(target, 'harness_queued', deps.clock, { source: 'harness', evidenceRef: EVIDENCE.queued });
      await recordQuietly(deps.evidence, receipt);
      return receipt;
    }
  }
}
