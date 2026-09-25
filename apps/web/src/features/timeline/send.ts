// Send + reconcile: keeps every local pending echo bound to its own
// `clientTxnId` until a durable event carrying that same transaction arrives
// through the controller's merged items. A `failed` or `outcome_unknown`
// result is resolved by re-sending the *same* transaction identity, never a
// fresh send with new bytes (R3; AE2) — the transport dedups on
// `clientTxnId`, so retrying a definite failure is as safe as resolving an
// ambiguous one.

import type { RoomId } from '@khala/contracts/messaging/ids';
import type { MessageContent, ChannelPort } from '@khala/contracts/messaging/index';
import type { OperationResult } from '@khala/contracts/messaging/outcomes';
import type { ChannelRejection, SendState } from '@khala/contracts/messaging/index';
import type { SendPhase } from './model';

export type PendingSend = Readonly<{
  clientTxnId: string;
  content: MessageContent;
  phase: SendPhase;
}>;

function phaseFor(result: OperationResult<SendState, ChannelRejection>): SendPhase {
  switch (result.kind) {
    case 'ok':
      return result.value.state;
    case 'outcome_unknown':
      return 'outcome_unknown';
    case 'unavailable':
    case 'rejected':
      return 'failed';
  }
}

/** Sends one draft under a caller-supplied `clientTxnId`; the caller owns that identity's lifetime. */
export async function sendDraft(roomPort: ChannelPort, roomId: RoomId, clientTxnId: string, content: MessageContent): Promise<PendingSend> {
  const result = await roomPort.send({ roomId, clientTxnId, content });
  return { clientTxnId, content, phase: phaseFor(result) };
}

/** Retries a `failed` or `outcome_unknown` pending send by re-sending the identical transaction/content. */
export async function retrySend(roomPort: ChannelPort, roomId: RoomId, pending: PendingSend): Promise<PendingSend> {
  const result = await roomPort.send({ roomId, clientTxnId: pending.clientTxnId, content: pending.content });
  return { ...pending, phase: phaseFor(result) };
}

/** True once a durable item carrying this transaction has arrived; the caller should drop the local echo. */
export function isReconciled(pending: PendingSend, items: readonly Readonly<{ clientTxnId: string | null }>[]): boolean {
  return items.some(item => item.clientTxnId === pending.clientTxnId);
}
