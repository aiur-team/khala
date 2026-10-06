import type { EventId, RoomId, OwnerId } from '@khala/contracts/messaging/index';
import type { ConversationSummary } from '../../ui/conversation';

/** Owner-scoped local Matrix projection. The adapter owns authentication and decryption. */
export interface ConversationIndexPort {
  /** Persist the exact latest event the focused viewer has seen. */
  markRead?(ownerId: OwnerId, generation: number, roomId: RoomId, eventId: EventId): void | Promise<void>;
  snapshot(ownerId: OwnerId, generation: number): readonly ConversationSummary[] | null | undefined;
  subscribe(ownerId: OwnerId, generation: number, listener: () => void): () => void;
}

export function sortConversations(items: readonly ConversationSummary[]): readonly ConversationSummary[] {
  return [...items].sort((a, b) => {
    const byActivity = (b.timestamp ?? '').localeCompare(a.timestamp ?? '');
    return byActivity || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}
