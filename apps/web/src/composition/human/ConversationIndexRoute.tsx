import { useEffect, useState } from 'react';
import { ConversationLayout, ConversationList, type ConversationSummary } from '../../ui/conversation';
import type { HumanRouteContext } from './application';
import type { HumanRouteCodec } from './routes';

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

export function ConversationIndexRoute({ context, routes, navigate }: Readonly<{
  context: HumanRouteContext;
  routes: HumanRouteCodec;
  navigate(path: string): void;
}>) {
  const [query, setQuery] = useState('');
  const items = useConversationIndex(context);
  return <ConversationLayout list={<ConversationList conversations={items ?? []} query={query} onQueryChange={setQuery}
    emptyLabel="No encrypted conversations yet."
    onSelect={id => { if (items?.some(item => item.id === id)) navigate(routes.roomPath(id)); }}
    status={!context.conversations || items === null ? 'error' : items === undefined ? 'loading' : 'ready'} />} />;
}
