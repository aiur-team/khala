// Send + reconcile: keeps every local pending echo bound to its own
// `clientTxnId` until a durable event carrying that transaction or the
// acknowledged event ID arrives through the controller's merged items. A
// `failed` or `outcome_unknown` result is resolved by re-sending the *same*
// transaction identity, never a fresh send with new bytes (R3; AE2). The transport dedups on
// `clientTxnId`, so retrying a definite failure is as safe as resolving an
// ambiguous one.

import type { EventId, RoomId } from '@khala/contracts/messaging/ids';
import type { MessageContent, ChannelPort } from '@khala/contracts/messaging/index';
import type { OperationResult } from '@khala/contracts/messaging/outcomes';
import type { ChannelRejection, SendState } from '@khala/contracts/messaging/index';
import type { SendPhase } from './model';

export type PendingSend = Readonly<{
  clientTxnId: string;
  content: MessageContent;
  phase: SendPhase;
  /** The acknowledged Matrix event, even when a later sync omits its transaction ID. */
  eventId?: EventId;
}>;

function resultFor(result: OperationResult<SendState, ChannelRejection>): Pick<PendingSend, 'phase' | 'eventId'> {
  switch (result.kind) {
    case 'ok':
      return result.value.eventRef
        ? { phase: result.value.state, eventId: result.value.eventRef.eventId }
        : { phase: result.value.state };
    case 'outcome_unknown':
      return { phase: 'outcome_unknown' };
    case 'unavailable':
    case 'rejected':
      return { phase: 'failed' };
  }
}

/** Sends one draft under a caller-supplied `clientTxnId`; the caller owns that identity's lifetime. */
export async function sendDraft(roomPort: ChannelPort, roomId: RoomId, clientTxnId: string, content: MessageContent): Promise<PendingSend> {
  const result = await roomPort.send({ roomId, clientTxnId, content });
  return { clientTxnId, content, ...resultFor(result) };
}

/** Retries a `failed` or `outcome_unknown` pending send by re-sending the identical transaction/content. */
export async function retrySend(roomPort: ChannelPort, roomId: RoomId, pending: PendingSend): Promise<PendingSend> {
  const result = await roomPort.send({ roomId, clientTxnId: pending.clientTxnId, content: pending.content });
  return { clientTxnId: pending.clientTxnId, content: pending.content, ...resultFor(result) };
}

/** Match an exact transaction or acknowledged event; never match message content. */
export function isReconciled(pending: PendingSend, items: readonly Readonly<{ clientTxnId: string | null; ref: Readonly<{ eventId: EventId }> }>[]): boolean {
  return items.some(item => item.clientTxnId === pending.clientTxnId
    || (pending.eventId !== undefined && item.ref.eventId === pending.eventId));
}
