import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LocalTransport } from '@khala/messaging/local/http/index';
import type { ChannelAccessInboxController } from '../../features/channel-access/controller';
import type { ChannelSettingsPort } from '../../features/channel-settings/ports';
import { ChannelRequestsRoute, OwnerShell } from '../channel-requests/OwnerShell';
import { ChannelSettingsRoute } from '../channel-settings/ChannelSettingsRoute';
import { CreateChannelScreen } from '../../features/create-channel/CreateChannelScreen';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ShellMode } from '../../shell/types';
import type { HumanApplicationHandle, HumanRouteContext } from '../../composition/human/application';
import { HumanScreen } from '../../composition/human/screen';
import { LocalRoom, SessionEnded } from './room';
import type { LocalRoute, LocalRouteCodec } from './routes';

export type LocalApplicationScreenProps = Readonly<{
  application: HumanApplicationHandle;
  routes: LocalRouteCodec;
  transport: LocalTransport;
  navigateRoute: (path: string) => void;
  /** Owner-only capabilities, backed by human-cookie routes and never by an agent credential. */
  owner: Readonly<{
    createChannelAccess: () => ChannelAccessInboxController;
    settings: ChannelSettingsPort;
  }>;
  mode?: ShellMode;
}>;

/** Moves focus to a route's heading so a screen-reader user hears the new page. */
function NotFound() {
  const heading = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <KhalaPageFrame model={{ title: 'Page not found', labelledBy: 'khala-not-found' }}>
      <p role="alert" ref={heading} tabIndex={-1}>This local Khala page does not exist.</p>
    </KhalaPageFrame>
  );
}

function channelIdIn(path: string, routes: LocalRouteCodec): string | null {
  const route = routes.parse(path);
  return route.kind === 'channel' ? route.roomId : null;
}

/**
 * Turns a plain primary click on an in-app link into a client route change, so
 * the shell and its inbox controller survive navigation. Modified clicks, other
 * targets and unknown paths keep the browser's own behavior.
 */
function RouteLinks({ routes, navigateRoute, children }: {
  routes: LocalRouteCodec;
  navigateRoute: (path: string) => void;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[href]');
    if (!anchor || (anchor.getAttribute('target') ?? '_self') !== '_self' || anchor.hasAttribute('download')) return;
    const route = routes.parse(anchor.getAttribute('href')!);
    if (route.kind === 'not_found') return;
    event.preventDefault();
    navigateRoute(route.path);
  };
  return <div style={{ display: 'contents' }} onClick={onClick}>{children}</div>;
}

/**
 * The internal-mode application: private create and channel routes only. It
 * has no sign-in, share, join or recovery route, and a refused session is a
 * terminal relaunch instruction rather than a sign-in prompt.
 */
export function LocalApplicationScreen({ application, routes, transport, navigateRoute, owner, mode = 'standalone' }: LocalApplicationScreenProps) {
  const renderRoute = (context: HumanRouteContext, route: LocalRoute): ReactNode => {
    switch (route.kind) {
      case 'create':
        return (
          <KhalaPageFrame model={{ title: 'Khala', description: 'Create a private local channel.', labelledBy: 'khala-create-title' }}>
            <CreateChannelScreen ports={context} mode="private" onOpenRoom={roomId => navigateRoute(routes.roomPath(roomId))} />
          </KhalaPageFrame>
        );
      case 'channel':
        return (
          <>
            <p><a className="internal-owner-link" href={routes.settingsPath(route.roomId)}>Channel discovery settings</a></p>
            <LocalRoom context={context} roomId={route.roomId} transport={transport} />
          </>
        );
      case 'channel_settings':
        return <ChannelSettingsRoute settings={owner.settings} roomId={route.roomId} channelHref={routes.roomPath(route.roomId)} />;
      case 'channel_requests':
        return <ChannelRequestsRoute selectedHandle={route.selectedHandle} />;
      case 'not_found':
        return <NotFound />;
    }
  };

  return (
    <RouteLinks routes={routes} navigateRoute={navigateRoute}>
      <HumanScreen
        application={application}
        routes={routes}
        mode={mode}
        renderRoute={renderRoute}
        renderReadyShell={(context, chrome, children) => (
          <OwnerShell key={context.principal.ownerId} createController={owner.createChannelAccess} routes={routes} chrome={chrome}>
            {children}
          </OwnerShell>
        )}
        renderSignedOut={path => (
          <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-session-ended' }}>
            <SessionEnded roomId={channelIdIn(path, routes)} />
          </KhalaPageFrame>
        )}
      />
    </RouteLinks>
  );
}

export function mountLocalApplication(target: Element, props: LocalApplicationScreenProps): Readonly<{ dispose(): void }> {
  const root = createRoot(target);
  root.render(<LocalApplicationScreen {...props} />);
  return { dispose: () => root.unmount() };
}
