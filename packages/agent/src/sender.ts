import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { SessionMessage } from './transport';

function localpart(userId: string): string {
  return /^@([^:]+):/u.exec(userId)?.[1] ?? userId;
}
export function senderKindOf(userId: string): InboxEntry['senderKind'] {
  const name = localpart(userId);
  return name.startsWith('agent-') ? 'agent' : name.startsWith('khala_') ? 'human' : 'unknown';
}

/** The Matrix rich-reply parent of each entry; kept off `InboxEntry`, whose shape is a strict contract. */
const replyParents = new WeakMap<InboxEntry, string>();

export function toInboxEntry(message: SessionMessage, displayName?: string | null): InboxEntry {
  const entry: InboxEntry = {
    eventId: message.eventId, roomId: message.roomId, ts: new Date(message.ts).toISOString(),
    sender: message.sender,
    senderLabel: displayName && displayName !== message.sender ? displayName : localpart(message.sender),
    senderKind: senderKindOf(message.sender), kind: 'message', body: message.body,
  };
  const relates = message.content['m.relates_to'];
  const reply = typeof relates === 'object' && relates !== null ? (relates as Record<string, unknown>)['m.in_reply_to'] : undefined;
  const parent = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>).event_id : undefined;
  if (typeof parent === 'string') replyParents.set(entry, parent);
  return entry;
}

/** Prefixes each reply with `↪ reply to <author>: <snippet>` from the parent in the same page. Content stays untrusted data. */
export function withReplyContext(entries: readonly InboxEntry[]): InboxEntry[] {
  const byId = new Map(entries.map(entry => [entry.eventId, entry]));
  return entries.map(entry => {
    const parentId = replyParents.get(entry);
    if (parentId === undefined) return entry;
    const parent = byId.get(parentId);
    const line = parent ? parent.body.replace(/\s+/gu, ' ').trim() : '';
    const quoted = parent ? `${parent.senderLabel}: ${line.length > 80 ? `${line.slice(0, 79)}…` : line}` : 'an earlier message';
    return { ...entry, body: `↪ reply to ${quoted}\n${entry.body}` };
  });
}
