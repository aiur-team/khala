// What a Cursor observation may be credited as. Cursor reports no model-context
// consumption to a hook or MCP server, so no observation here ever becomes
// `context_consumed`: a hook's accepted output is at most a queued claim, and only the
// batch token returned on a later agent call acknowledges a batch.

import { createHash } from 'node:crypto';
import type {
  AppHarnessRecord, Clock, DeliveryReceipt, ReceiptErrorCode, ReceiptId, ReceiptKindV2, ReleasedJob,
} from '@khala/contracts/delivery/index';

export type CursorObservation =
  /** Cursor accepted a hook's `additional_context` (`postToolUse`) or `followup_message` (`stop`). */
  | Readonly<{ kind: 'hook_output_accepted'; boundary: 'postToolUse' | 'stop' }>
  /** `khala_read` returned the batch to the calling chat. */
  | Readonly<{ kind: 'read_returned' }>
  /** A later agent call presented the batch token. */
  | Readonly<{ kind: 'next_call_acknowledged' }>;

const MODE_OF = { postToolUse: 'steer', stop: 'sync' } as const;

/** The receipt kind an observation earns under `record`, or `null` when it earns none. */
export function cursorReceiptKind(observation: CursorObservation, record: AppHarnessRecord): ReceiptKindV2 | null {
  const { modes, acknowledgement } = record.capabilities;
  switch (observation.kind) {
    case 'hook_output_accepted': {
      const mode = MODE_OF[observation.boundary];
      if (record.boundaries[mode] !== observation.boundary || modes[mode].status !== 'proven') return null;
      return 'harness_queued';
    }
    case 'read_returned':
      return record.boundaries.async === 'khala_read' && modes.async.status === 'proven' ? 'harness_queued' : null;
    case 'next_call_acknowledged':
      return acknowledgement === 'batch_token_next_call' ? 'agent_acknowledged' : null;
  }
}

/** The connector's refusal. Stable: the same release, generation and code yield the same ID. */
export function cursorFailedReceipt(job: ReleasedJob, errorCode: ReceiptErrorCode, clock: Clock): DeliveryReceipt {
  const { releaseId, binding } = job;
  const digest = createHash('sha256')
    .update(JSON.stringify(['cursor', binding.bindingId, binding.generation, releaseId, 'failed', errorCode]))
    .digest('hex');
  return {
    v: 1,
    receiptId: `cursor-receipt-${digest}` as ReceiptId,
    releaseId,
    bindingId: binding.bindingId,
    generation: binding.generation,
    kind: 'failed',
    observedAt: clock.now().toISOString(),
    source: 'connector',
    evidenceRef: null,
    errorCode,
  };
}
