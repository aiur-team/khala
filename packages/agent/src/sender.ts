import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { SessionMessage } from './transport';

function localpart(userId: string): string {
  return /^@([^:]+):/u.exec(userId)?.[1] ?? userId;
}
export function senderKindOf(userId: string): InboxEntry['senderKind'] {
  const name = localpart(userId);
  return name.startsWith('agent-') ? 'agent' : name.startsWith('khala_') ? 'human' : 'unknown';
}
export function toInboxEntry(message: SessionMessage, displayName?: string | null): InboxEntry {
  return {
    eventId: message.eventId, roomId: message.roomId, ts: new Date(message.ts).toISOString(),
    sender: message.sender,
    senderLabel: displayName && displayName !== message.sender ? displayName : localpart(message.sender),
    senderKind: senderKindOf(message.sender), kind: 'message', body: message.body,
  };
}
