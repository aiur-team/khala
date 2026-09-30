import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChannelAccessRequestHandle } from '@khala/contracts/messaging/index';
import { ChannelRequestsInbox } from '../../features/channel-access/ChannelRequestsInbox';
import type { ChannelAccessInboxController } from '../../features/channel-access/controller';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { ConversationList } from '../../ui/conversation';
import { ChannelRequestsNavEntry } from '../../features/channel-access/ChannelRequestsNavEntry';
import type { HumanShellChrome } from '../../composition/human/screen';
import type { HumanRouteContext } from '../../composition/human/application';
import { CreateChannelDialog } from '../../composition/human/CreateChannelDialog';
import { useConversationIndex } from '../../composition/human/ConversationIndexRoute';
import type { LocalRouteCodec } from '../composition/routes';
import aiurLogo from '../../landing/public/assets/aiur-logo.png';
import { ThemeIcon } from '../../shell/icons';

/** The loopback server has no notification stream, so the inbox is reread on this interval. */
export const INBOX_POLL_MS = 5_000;

const InboxContext = createContext<ChannelAccessInboxController | null>(null);

export function ChannelRequestsRoute({ selectedHandle }: { selectedHandle: ChannelAccessRequestHandle | null }) {
  const controller = useContext(InboxContext);
  return (
    <KhalaPageFrame model={{ title: 'Channel requests', labelledBy: 'khala-channel-requests-title' }}>
      {controller === null ? null : <ChannelRequestsInbox controller={controller} selectedHandle={selectedHandle} embedded />}
    </KhalaPageFrame>
  );
}

/**
 * Owner-only navigation and the one shared inbox controller. It renders only
 * for a ready human session, so no agent or discovery credential ever sees it.
 */
export function OwnerShell({ createController, routes, chrome, context, navigateRoute, children }: {
  createController: () => ChannelAccessInboxController;
  routes: LocalRouteCodec;
  chrome: HumanShellChrome;
  context: HumanRouteContext;
  navigateRoute(path: string): void;
  children: ReactNode;
}) {
  const [controller] = useState(createController);
  const route = routes.parse(chrome.path);
  const roomId = 'roomId' in route ? route.roomId : null;
  const conversations = useConversationIndex(context);
  const listed = conversations ?? (roomId ? [{ id: roomId, title: 'Channel', preview: null, timestamp: null, unreadCount: null }] : []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const drawerButton = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setDrawerOpen(false); }, [chrome.path]);
  useEffect(() => { setCreateOpen(false); }, [chrome.path]);
  useEffect(() => { if (drawerOpen) drawerClose.current?.focus(); }, [drawerOpen]);
  useEffect(() => {
    controller.start();
    const timer = setInterval(() => controller.refresh(), INBOX_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.dispose();
    };
  }, [controller]);
  const themeAction = <button type="button" className="aiur-shell__theme-toggle aiur-shell__icon-button" aria-label="Toggle color theme"
    onClick={() => chrome.theme.onThemeChange(chrome.theme.theme === 'dark' ? 'light' : 'dark')}>
    <ThemeIcon />
  </button>;
  return <main className="khala-local-shell"><AiurShell mode="hosted-content" navigation={[]} theme={chrome.theme}
    collapsed={chrome.collapsed} onCollapsedChange={chrome.onCollapsedChange}
    sidebar={<div ref={drawer} className={`khala-sidebar${drawerOpen ? ' khala-sidebar--open' : ''}`}
      role={drawerOpen ? 'dialog' : undefined} aria-modal={drawerOpen || undefined} aria-label={drawerOpen ? 'Channels' : undefined}
      onKeyDown={event => {
      if (event.key === 'Escape') { setDrawerOpen(false); drawerButton.current?.focus(); return; }
      if (event.key !== 'Tab' || !drawerOpen) return;
      const focusable = [...(drawer.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]') ?? [])]
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <button ref={drawerClose} type="button" className="khala-sidebar__close aiur-shell__icon-button" aria-label="Close channels"
        onClick={() => { setDrawerOpen(false); drawerButton.current?.focus(); }}>×</button>
      <div className="khala-local-sidebar__brand"><a className="aiur-shell__brand" href={routes.createPath()}><img src={aiurLogo} alt="" width="1215" height="1068" />KHALA</a>{themeAction}</div>
      <ConversationList conversations={listed}
        selectedId={route.kind === 'channel' ? roomId : null} query="" onQueryChange={() => undefined} showSearch={false}
        status={conversations === undefined ? 'loading' : conversations === null ? 'error' : 'ready'}
        onSelect={id => { setDrawerOpen(false); navigateRoute(routes.roomPath(id)); }}
        action={<><ChannelRequestsNavEntry controller={controller} href={routes.channelRequestsPath()}
          current={route.kind === 'channel_requests'} onNavigate={() => { setDrawerOpen(false); navigateRoute(routes.channelRequestsPath()); }} />
          <button ref={createButton} type="button" className="aiur-shell__icon-button" aria-label="Create channel" title="Create channel"
            onClick={() => { setDrawerOpen(false); setCreateOpen(true); }}>+</button></>} />
    </div>}>
    <div className="khala-mobile-bar"><button ref={drawerButton} type="button" className="aiur-shell__icon-button" aria-label="Channels"
      aria-expanded={drawerOpen} onClick={() => setDrawerOpen(value => !value)}>☰</button><a className="aiur-shell__brand" href={routes.createPath()}>KHALA</a>{themeAction}</div>
    <InboxContext.Provider value={controller}>{children}</InboxContext.Provider>
    {createOpen ? <CreateChannelDialog context={context} mode="private" onClose={() => setCreateOpen(false)}
      onOpenRoom={id => { setCreateOpen(false); navigateRoute(routes.roomPath(id)); }}
      returnFocus={() => (window.matchMedia('(max-width: 959px)').matches ? drawerButton.current : createButton.current)?.focus()} /> : null}
  </AiurShell></main>;
}
