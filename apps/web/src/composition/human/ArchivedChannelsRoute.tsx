// Settings > Archived channels: the viewer's archived channels, unread ones
// marked, each openable and unarchivable. Archived channels are reachable
// only here unless one has new messages (then the index's bottom row links here).

import { decodeRoomId } from '@khala/contracts/messaging/index';
import { useState } from 'react';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { ChevronLeftIcon } from '../../ui/khala/icons';
import type { HumanRouteContext } from './application';
import { useConversationIndex } from './ConversationIndexRoute';
import type { HumanRouteCodec } from './routes';

export function ArchivedChannelsRoute({ context, routes, navigateRoute }: Readonly<{
  context: HumanRouteContext; routes: HumanRouteCodec; navigateRoute(path: string): void;
}>) {
  const index = useConversationIndex(context);
  const archived = (index ?? []).filter(item => item.archived);
  const [failed, setFailed] = useState(false);
  const unarchive = async (id: string) => {
    const roomId = decodeRoomId(id);
    setFailed(!roomId.ok || (await context.setArchived?.(roomId.value, false)) !== 'sent');
  };
  return <KhalaPageFrame model={{ title: 'Archived channels', labelledBy: 'khala-archived',
    description: 'Archived channels stay joined but leave your channel list, and your agents stop listening in them.' }}
    banner={failed ? 'Unarchive failed. Try again.' : undefined}>
    <p><a className="kh-archived-back" href={routes.conversationsPath()} onClick={event => { event.preventDefault(); navigateRoute(routes.conversationsPath()); }}>
      <ChevronLeftIcon /> Channels</a></p>
    {index === undefined ? <p role="status">Loading channels…</p> : index === null ? <p role="alert">Channels are unavailable. Try reloading.</p>
      : archived.length === 0 ? <p role="status">No archived channels.</p> : <ul className="kh-archived">
      {archived.map(item => <li key={item.id} className={item.unreadCount ? 'unread' : undefined}>
        <a href={routes.roomPath(item.id)} onClick={event => { event.preventDefault(); navigateRoute(routes.roomPath(item.id)); }}>
          {item.unreadCount ? <span className="kh-cv-unread" aria-hidden="true" /> : null}
          <b dir="auto">{item.title}</b>
          {item.unreadCount ? <em>{item.unreadCount} new</em> : null}
        </a>
        {context.setArchived ? <button type="button" className="tool-btn" onClick={() => void unarchive(item.id)}>Unarchive</button> : null}
      </li>)}
    </ul>}
  </KhalaPageFrame>;
}
