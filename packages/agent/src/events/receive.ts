import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { decodeChannelEvent, formatChannelEventLine } from '@khala/contracts/m1/channel-event';

export function toEventInboxEntry(base: Omit<InboxEntry, 'kind' | 'body'>, rawContent: unknown): { entry: InboxEntry; key?: string } | null {
  const decoded = decodeChannelEvent(rawContent);
  if (!decoded.ok) return null;
  const content = decoded.value;
  return {
    entry: { ...base, kind: 'event', body: formatChannelEventLine(content) + (content.url ? ' ' + content.url : '') },
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
  return entry.kind === 'message';
}
