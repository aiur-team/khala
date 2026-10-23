import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { decodeChannelEvent, formatChannelEventLine } from '@khala/contracts/m1/channel-event';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';

/** `you` is the agent's own display name: a handoff addressed to it is delivered like a mention. */
export function toEventInboxEntry(base: Omit<InboxEntry, 'kind' | 'body'>, rawContent: unknown, you?: string): { entry: InboxEntry; key?: string } | null {
  const decoded = decodeChannelEvent(rawContent);
  if (!decoded.ok) return null;
  const content = decoded.value;
  const to = content.kind === 'handoff' ? String(content.data?.to ?? '').replace(/^@/u, '').toLowerCase() : '';
  return {
    entry: { ...base, kind: 'event', body: formatChannelEventLine(content) + (content.url ? ' ' + content.url : ''), eventKind: content.kind,
      ...(content.data ? { data: content.data } : {}), ...(to && to === you?.toLowerCase() ? { mention: true as const } : {}) },
    ...(content.key !== undefined ? { key: content.key } : {}),
  };
}

export function createEventKeyFilter(): (key: string | undefined) => boolean {
  const seen = new Set<string>();
  return key => {
    if (key === undefined) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

export function isWakeEntry(entry: InboxEntry): boolean {
  return entry.kind === 'message' || entry.mention === true;
}

/** `@channel` (everyone) and `@agents` address every agent; `@humans` does not. */
const agentGroupMention = /(?<![\p{L}\p{N}_@])@(?:channel|agents)(?![\p{L}\p{N}_])/iu;

export function mentions(entry: InboxEntry, name: string | undefined): boolean {
  if (entry.kind === 'message' && agentGroupMention.test(entry.body)) return true;
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])@?${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(entry.body);
}

/** Sync wakes an idle agent, or re-opens its turn at Stop, only for a message from a
 * person (or an unclassified sender) or one that names it. Other agents' messages wait for the
 * next turn's hook context. */
export function wakesAgent(entry: InboxEntry, mode: ListeningMode | undefined, you: string | undefined): boolean {
  return isWakeEntry(entry) && (mode !== 'sync' || entry.senderKind !== 'agent' || entry.mention === true || mentions(entry, you));
}
