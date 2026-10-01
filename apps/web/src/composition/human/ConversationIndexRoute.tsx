import { useEffect, useState } from 'react';
import type { ConversationSummary } from '../../ui/conversation';
import type { HumanRouteContext } from './application';

export function useConversationIndex(context: HumanRouteContext) {
  const [stored, setStored] = useState<Readonly<{ scope: string; port: HumanRouteContext['conversations']; items: readonly ConversationSummary[] | null | undefined }> | null>(null);
  const ownerId = context.principal.ownerId;
  const generation = context.generation;
  const scope = JSON.stringify([ownerId, generation]);
  useEffect(() => {
    const port = context.conversations;
    if (!port) return undefined;
    const update = () => setStored({ scope, port, items: port.snapshot(ownerId, generation) });
    const dispose = port.subscribe(ownerId, generation, update);
    update();
    return dispose;
  }, [context.conversations, ownerId, generation, scope]);
  return stored?.scope === scope && stored.port === context.conversations ? stored.items : undefined;
}

export function ConversationIndexRoute() {
  return <section className="khala-empty-conversation" aria-label="No channel selected">
    <p>Select a channel to read its messages.</p>
  </section>;
}
