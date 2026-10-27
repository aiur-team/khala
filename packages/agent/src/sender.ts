import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { SessionMessage } from './transport';
import { imageLabel, readImageEvent } from '@khala/contracts/m1/image';

function localpart(userId: string): string {
  return /^@([^:]+):/u.exec(userId)?.[1] ?? userId;
}
export function senderKindOf(userId: string): InboxEntry['senderKind'] {
  const name = localpart(userId);
  return name.startsWith('agent-') ? 'agent' : name.startsWith('khala_') ? 'human' : 'unknown';
}

/** The Matrix rich-reply parent of each entry; kept off `InboxEntry`, whose shape is a strict contract. */
const replyParents = new WeakMap<InboxEntry, string>();

/** `[image: name, WxH]` plus any caption; fetched only on request (read download), never in a wake. */
function imageBody(message: SessionMessage): string | undefined {
  const found = message.type === 'm.room.message' ? readImageEvent(message.content) : null;
  return found ? `${imageLabel(found.image)}${found.caption ? `\n${found.caption}` : ''}` : undefined;
}

export function toInboxEntry(message: SessionMessage, displayName?: string | null): InboxEntry {
  const entry: InboxEntry = {
    eventId: message.eventId, roomId: message.roomId, ts: new Date(message.ts).toISOString(),
    sender: message.sender,
    senderLabel: displayName && displayName !== message.sender ? displayName : localpart(message.sender),
    senderKind: senderKindOf(message.sender), kind: 'message', body: imageBody(message) ?? message.body,
  };
  const relates = message.content['m.relates_to'];
  const reply = typeof relates === 'object' && relates !== null ? (relates as Record<string, unknown>)['m.in_reply_to'] : undefined;
  const parent = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>).event_id : undefined;
  if (typeof parent === 'string') replyParents.set(entry, parent);
  return entry;
}

// ponytail: only read output carries reply context; hook-delivered inbox lines show the plain body.
/** Prefixes each reply with `↪ reply to <author>: <snippet>` from the parent in the same page. Content stays untrusted data. */
export function withReplyContext(entries: readonly InboxEntry[]): InboxEntry[] {
  const byId = new Map(entries.map(entry => [entry.eventId, entry]));
  return entries.map(entry => {
    const parentId = replyParents.get(entry);
    if (parentId === undefined) return entry;
    const parent = byId.get(parentId);
    const line = parent ? parent.body.replace(/\s+/gu, ' ').trim() : '';
    const quoted = parent ? `${parent.senderLabel}: ${line.length > 80 ? `${line.slice(0, 79)}…` : line}` : 'an earlier message';
    return { ...entry, body: `↪ reply to ${quoted}\n${stripReplyFallback(entry.body)}` };
  });
}

/** Drops a legacy Matrix reply fallback (`> <@sender> …` lines, then a blank line) that non-Khala clients still send. */
function stripReplyFallback(body: string): string {
  if (!/^> (\* )?<[@!][^>]+> /u.test(body)) return body;
  const lines = body.split('\n');
  const blank = lines.findIndex(line => !line.startsWith('>'));
  return blank > 0 && lines[blank] === '' && blank + 1 < lines.length ? lines.slice(blank + 1).join('\n') : body;
}
