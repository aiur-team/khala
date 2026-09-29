import type { ContentLimits } from '@khala/contracts/messaging/index';
import { API, REQUEST_SECRET_HEADER, decodeChannels } from '@khala/messaging/local/http/index';
import type { ConversationIndexPort } from '../../composition/human/conversations';
import { sortConversations } from '../../composition/human/conversations';
import type { ConversationSummary } from '../../ui/conversation';

export type LocalConversationIndex = ConversationIndexPort & Readonly<{ refresh(): Promise<void>; dispose(): void }>;

/** Reads the durable, owner-scoped local channel list; route changes trigger refreshes. */
export function createLocalConversationIndex(options: Readonly<{
  origin: string;
  requestSecret: string;
  limits: ContentLimits;
  fetch?: typeof globalThis.fetch;
}>): LocalConversationIndex {
  let items: readonly ConversationSummary[] | null | undefined;
  let request = 0;
  const listeners = new Set<() => void>();
  const fetcher = options.fetch ?? globalThis.fetch;

  function publish(next: typeof items) {
    items = next;
    for (const listener of listeners) listener();
  }

  return {
    snapshot: () => items,
    subscribe: (_ownerId, _generation, listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async refresh() {
      const current = ++request;
      try {
        const reply = await fetcher(`${options.origin}${API.channels}`, {
          method: 'GET', credentials: 'same-origin', headers: { [REQUEST_SECRET_HEADER]: options.requestSecret },
        });
        if (!reply.ok) throw new Error('channel list unavailable');
        const decoded = decodeChannels(await reply.json(), options.limits);
        if (!decoded.ok) throw new Error('invalid channel list');
        if (current !== request) return;
        publish(sortConversations(decoded.value.map(channel => ({
          id: channel.roomId, title: channel.title?.trim() || 'Channel', preview: null, timestamp: null, unreadCount: null,
        }))));
      } catch {
        if (current === request) publish(null);
      }
    },
    dispose() { request += 1; listeners.clear(); },
  };
}
