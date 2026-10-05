import type { EventId } from '@khala/contracts/messaging/ids';

/** One durable mark per seen latest event; failed writes can retry on the next check. */
export function createLatestReadTracker(markRead: (eventId: EventId) => void | Promise<void>) {
  let marked: EventId | null = null;
  return (eventId: EventId | null, state: Readonly<{ atLatest: boolean; focused: boolean; visible: boolean }>): void => {
    if (!eventId || !state.atLatest || !state.focused || !state.visible || marked === eventId) return;
    marked = eventId;
    try {
      void Promise.resolve(markRead(eventId)).catch(() => { if (marked === eventId) marked = null; });
    } catch { if (marked === eventId) marked = null; }
  };
}
