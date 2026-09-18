// Send + reconcile: keeps one local pending echo bound to its `clientTxnId`
// until a durable event carrying that same transaction arrives through the
// controller's merged items. An `outcome_unknown` result is resolved by
// re-sending the *same* transaction identity, never a fresh send with new
// bytes (R3; AE2).

import type { RoomId } from '@khala/contracts/messaging/ids';
import type { MessageContent, RoomPort } from '@khala/contracts/messaging/index';
import type { OperationResult } from '@khala/contracts/messaging/outcomes';
import type { RoomRejection, SendState } from '@khala/contracts/messaging/index';
import type { SendPhase } from './model';

export type PendingSend = Readonly<{
  clientTxnId: string;
  content: MessageContent;
  phase: SendPhase;
}>;

function phaseFor(result: OperationResult<SendState, RoomRejection>): SendPhase {
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
export async function sendDraft(roomPort: RoomPort, roomId: RoomId, clientTxnId: string, content: MessageContent): Promise<PendingSend> {
  const result = await roomPort.send({ roomId, clientTxnId, content });
  return { clientTxnId, content, phase: phaseFor(result) };
}

/** Re-resolves an `outcome_unknown` transaction by re-sending the identical transaction/content. */
export async function resolveOutcomeUnknown(roomPort: RoomPort, roomId: RoomId, pending: PendingSend): Promise<PendingSend> {
  const result = await roomPort.send({ roomId, clientTxnId: pending.clientTxnId, content: pending.content });
  return { ...pending, phase: phaseFor(result) };
}

/** True once a durable item carrying this transaction has arrived; the caller should drop the local echo. */
export function isReconciled(pending: PendingSend, items: readonly Readonly<{ clientTxnId: string | null }>[]): boolean {
  return items.some(item => item.clientTxnId === pending.clientTxnId);
}
