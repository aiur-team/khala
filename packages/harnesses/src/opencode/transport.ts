// Make a verified release durable in the binding generation's local inbox, then
// wake the OpenCode plugin with a `released` hint. The released bytes travel only
// into the inbox; the hint names only the binding generation and a reason, so the
// plugin always re-reads the canonical batch and its stable token.

import { createHash } from 'node:crypto';
import {
  type Clock, type DeliveryLimits, type DeliveryReceipt, type OpenCodeInboxHint, type ReceiptErrorCode,
  type ReleasedJob, type SessionBinding, sameSessionBinding, validatePayloadBytes,
} from '@khala/contracts/delivery/index';
import { openCodeReceipt } from './receipts';

/** Shape accepted by the durable inbox implemented by @aiur/khala. */
export type OpenCodeInboxDelivery = Readonly<{
  v: 1;
  releaseId: ReleasedJob['releaseId'];
  bindingId: ReleasedJob['binding']['bindingId'];
  generation: number;
  events: ReleasedJob['events'];
  payloadDigest: ReleasedJob['payloadDigest'];
  payload: Uint8Array;
  receivedAt: string;
}>;

export type OpenCodeHintReason = OpenCodeInboxHint['reason'];

/**
 * One binding generation's inbox. `enqueue` resolves only after the record is
 * synced; `duplicate` means the identical record is already durable.
 * `notifyListener` sends that generation's listener alone one encoded hint line.
 */
export interface OpenCodeInboxPort {
  enqueue(delivery: OpenCodeInboxDelivery): Promise<'appended' | 'duplicate'>;
  notifyListener(reason: OpenCodeHintReason): Promise<'notified' | 'unavailable'>;
}

export type OpenCodeSubmitDeps = Readonly<{
  clock: Clock;
  limits: DeliveryLimits;
}>;

export async function submitRelease(
  deps: OpenCodeSubmitDeps,
  inspected: SessionBinding | undefined,
  inbox: () => Promise<OpenCodeInboxPort>,
  job: ReleasedJob,
  payload: Uint8Array,
): Promise<DeliveryReceipt> {
  const failed = (errorCode: ReceiptErrorCode) => openCodeReceipt(job, 'failed', deps.clock, errorCode);
  if (!inspected) return failed('session_unavailable');
  if (!sameSessionBinding(inspected, job.binding)) return failed('stale_binding');
  const bytes = validatePayloadBytes(payload, deps.limits);
  if (!bytes.ok) return failed(bytes.code === 'limit_exceeded' ? 'limit_exceeded' : 'payload_digest_mismatch');
  if (sha256(bytes.value) !== job.payloadDigest) return failed('payload_digest_mismatch');

  let port: OpenCodeInboxPort;
  try {
    port = await inbox();
    // An identical duplicate proves the record is already durable, which is exactly
    // the crash window between append and hint: it may be hinted again.
    await port.enqueue({
      v: 1,
      releaseId: job.releaseId,
      bindingId: job.binding.bindingId,
      generation: job.binding.generation,
      events: job.events,
      payloadDigest: job.payloadDigest,
      payload: new Uint8Array(bytes.value),
      receivedAt: deps.clock.now().toISOString(),
    });
  } catch {
    // The append may or may not have been synced. No hint is sent for it.
    return openCodeReceipt(job, 'outcome_unknown', deps.clock, 'harness_unavailable');
  }

  // A missing or dead listener leaves the release durable; the next listener start
  // wakes once and reads it. Either way the receipt is a queued claim only: the
  // plugin holds the batch, and nothing here observes consumption.
  await port.notifyListener('released').catch(() => 'unavailable' as const);
  return openCodeReceipt(job, 'harness_queued', deps.clock);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
