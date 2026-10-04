// FROZEN COPY: the hosted Matrix event mapper `message()` from
// packages/agent/src/matrix/session.ts at origin/main 120d9ffa (pre-#1078).
// Do not edit: hosted rename/mode-change events must keep mapping cleanly with it.
import type { MatrixEvent } from 'matrix-js-sdk';

export type FrozenSessionMessage = { eventId: string; roomId: string; sender: string; ts: number; type: 'm.room.message' | 'com.khala.event.v1'; body: string; content: Record<string, unknown> };

export function frozenMainMatrixMessage(event: MatrixEvent): FrozenSessionMessage | undefined {
  const type = event.getType();
  const eventId = event.getId();
  const roomId = event.getRoomId();
  const sender = event.getSender();
  if (event.isDecryptionFailure() || !eventId || !roomId || !sender || (type !== 'm.room.message' && type !== 'com.khala.event.v1')) return;
  const content = event.getContent();
  return { eventId, roomId, sender, ts: event.getTs(), type, body: typeof content.body === 'string' ? content.body : '', content };
}
