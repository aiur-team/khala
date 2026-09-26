import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LocalTransport } from '@khala/messaging/local/http/index';
import { CreateChannelScreen } from '../../features/create-channel/CreateChannelScreen';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ShellMode } from '../../shell/types';
import type { HumanApplicationHandle, HumanRouteContext } from '../../composition/human/application';
import { HumanScreen } from '../../composition/human/screen';
import { MakeExternalPage } from '../make-external/MakeExternalPage';
import type { MakeExternalPort } from '../make-external/port';
import { LocalRoom, SessionEnded } from './room';
import type { LocalRoute, LocalRouteCodec } from './routes';

export type LocalApplicationScreenProps = Readonly<{
  application: HumanApplicationHandle;
  routes: LocalRouteCodec;
  transport: LocalTransport;
  navigateRoute: (path: string) => void;
  mode?: ShellMode;
  /** The Make-external journey; without it the channel page offers no such action. */
  makeExternal?: MakeExternalPort | null;
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
  return route.kind === 'channel' || route.kind === 'make_external' ? route.roomId : null;
}

/**
 * The internal-mode application: private create and channel routes only. It
 * has no sign-in, share, join or recovery route, and a refused session is a
 * terminal relaunch instruction rather than a sign-in prompt.
 */
export function LocalApplicationScreen({
  application, routes, transport, navigateRoute, mode = 'standalone', makeExternal = null,
}: LocalApplicationScreenProps) {
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
          <LocalRoom
            context={context}
            roomId={route.roomId}
            transport={transport}
            makeExternal={makeExternal}
            onMakeExternal={() => navigateRoute(routes.makeExternalPath(route.roomId))}
          />
        );
      case 'make_external':
        return makeExternal
          ? <MakeExternalPage port={makeExternal} channelId={route.roomId} onBack={() => navigateRoute(routes.roomPath(route.roomId))} />
          : <NotFound />;
      case 'not_found':
        return <NotFound />;
    }
  };

  return (
    <HumanScreen
      application={application}
      routes={routes}
      mode={mode}
      renderRoute={renderRoute}
      renderSignedOut={path => (
        <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-session-ended' }}>
          <SessionEnded roomId={channelIdIn(path, routes)} />
        </KhalaPageFrame>
      )}
    />
  );
}

export function mountLocalApplication(target: Element, props: LocalApplicationScreenProps): Readonly<{ dispose(): void }> {
  const root = createRoot(target);
  root.render(<LocalApplicationScreen {...props} />);
  return { dispose: () => root.unmount() };
}
