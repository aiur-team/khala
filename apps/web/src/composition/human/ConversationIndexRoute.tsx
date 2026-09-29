import { useEffect, useState } from 'react';
import type { ConversationSummary } from '../../ui/conversation';
import type { HumanRouteContext } from './application';

export function useConversationIndex(context: HumanRouteContext) {
  const [items, setItems] = useState<readonly ConversationSummary[] | null | undefined>(undefined);
  const ownerId = context.principal.ownerId;
  const generation = context.generation;
  useEffect(() => {
    const port = context.conversations;
    if (!port) return undefined;
    const update = () => setItems(port.snapshot(ownerId, generation));
    const dispose = port.subscribe(ownerId, generation, update);
    update();
    return dispose;
  }, [context.conversations, ownerId, generation]);
  return items;
}

export function ConversationIndexRoute() {
  return <section className="khala-empty-conversation" aria-label="No channel selected">
    <p>Select a channel to read its messages.</p>
  </section>;
}
