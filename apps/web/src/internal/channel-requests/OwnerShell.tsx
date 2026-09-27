import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ChannelAccessRequestHandle } from '@khala/contracts/messaging/index';
import { ChannelRequestsInbox } from '../../features/channel-access/ChannelRequestsInbox';
import { ChannelRequestsNavEntry } from '../../features/channel-access/ChannelRequestsNavEntry';
import type { ChannelAccessInboxController } from '../../features/channel-access/controller';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { HumanShellChrome } from '../../composition/human/screen';
import type { LocalRouteCodec } from '../composition/routes';

/** The loopback server has no notification stream, so the inbox is reread on this interval. */
export const INBOX_POLL_MS = 5_000;

const InboxContext = createContext<ChannelAccessInboxController | null>(null);

export function ChannelRequestsRoute({ selectedHandle }: { selectedHandle: ChannelAccessRequestHandle | null }) {
  const controller = useContext(InboxContext);
  return (
    <KhalaPageFrame model={{ title: 'Channel requests', labelledBy: 'khala-channel-requests-title' }}>
      {controller === null ? null : <ChannelRequestsInbox controller={controller} selectedHandle={selectedHandle} />}
    </KhalaPageFrame>
  );
}

/**
 * Owner-only navigation and the one shared inbox controller. It renders only
 * for a ready human session, so no agent or discovery credential ever sees it.
 */
export function OwnerShell({ createController, routes, chrome, children }: {
  createController: () => ChannelAccessInboxController;
  routes: LocalRouteCodec;
  chrome: HumanShellChrome;
  children: ReactNode;
}) {
  const [controller] = useState(createController);
  const onRequests = routes.parse(chrome.path).kind === 'channel_requests';
  useEffect(() => {
    controller.start();
    const timer = setInterval(() => controller.refresh(), INBOX_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.dispose();
    };
  }, [controller]);
  return (
    <AiurShell
      mode={chrome.mode}
      navigation={[
        { id: 'khala', label: 'Khala', href: routes.createPath(), current: !onRequests },
        {
          id: 'channel-requests',
          label: 'Channel requests',
          href: routes.channelRequestsPath(),
          current: onRequests,
          content: <ChannelRequestsNavEntry controller={controller} href={routes.channelRequestsPath()} current={onRequests} />,
        },
      ]}
      theme={chrome.theme}
      collapsed={chrome.collapsed}
      onCollapsedChange={chrome.onCollapsedChange}
    >
      <InboxContext.Provider value={controller}>{children}</InboxContext.Provider>
    </AiurShell>
  );
}
