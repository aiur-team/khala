// Internal-mode browser entry, served by the local loopback server from
// `INTERNAL_WEB_BUNDLE_DIRECTORY`. It composes the hosted human application
// over local ports; nothing here reaches Matrix, OAuth, sharing or recovery.

import { createRoot } from 'react-dom/client';
import { MAX_CHANNEL_TITLE_BYTES, decodeContentLimits } from '@khala/contracts/messaging/index';
import { createHumanApplication } from '../composition/human/application';
import { KhalaPageFrame } from '../shell/KhalaPageFrame';
import { createChannelAccessInboxController } from '../features/channel-access/controller';
import { createLocalChannelAccessPort } from './channel-requests/ports';
import { createLocalChannelSettingsPort } from './channel-settings/ports';
import { createHumanClient } from './composition/human-client';
import { createLocalPorts, readRequestSecret } from './composition/ports';
import { SessionEnded } from './composition/room';
import { createLocalRouteCodec } from './composition/routes';
import { mountLocalApplication } from './composition/screen';
import '../brand/fonts.css';
import '../brand/tokens.css';
import '../shell/shell.css';
import '../features/create-channel/create-channel.css';
import '../features/timeline/timeline.css';
import '../features/channel/channel.css';
import '../features/approval-decision/approval-decision.css';
import '../features/channel-access/channel-access.css';
import '../features/channel-settings/channel-settings.css';
import '../main.css';
import './internal.css';

const target = document.querySelector('#app');
if (!target) throw new Error('missing Khala application mount');

// Matches the loopback server's message bound (`maxMessageBytes`).
const limits = decodeContentLimits({ maxBodyBytes: 16 * 1024, maxDisplayNameBytes: 255, maxRoomTitleBytes: MAX_CHANNEL_TITLE_BYTES });
if (!limits.ok) throw new Error('invalid local content limits');

const routes = createLocalRouteCodec(location.origin);
const requestSecret = readRequestSecret();

if (requestSecret === null) {
  // Without the bootstrap's request secret no API call can succeed: relaunch is the only path.
  const route = routes.parse(`${location.pathname}${location.search}`);
  createRoot(target).render(
    <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-session-ended' }}>
      <SessionEnded roomId={route.kind === 'channel' ? route.roomId : null} />
    </KhalaPageFrame>,
  );
} else {
  const ports = createLocalPorts({ origin: location.origin, requestSecret, limits: limits.value });
  const application = createHumanApplication({
    identity: ports.identity,
    device: ports.device,
    room: ports.room,
    admission: ports.admission,
    participant: ports.participant,
    limits: ports.limits,
  }, { initialPath: `${location.pathname}${location.search}` });
  const navigateRoute = (path: string) => {
    history.pushState(null, '', path);
    application.navigate(path);
  };
  const humanClient = createHumanClient({ origin: location.origin, requestSecret });
  const owner = {
    createChannelAccess: () => createChannelAccessInboxController({ requests: createLocalChannelAccessPort(humanClient) }),
    settings: createLocalChannelSettingsPort(humanClient),
  };
  const mounted = mountLocalApplication(target, { application, routes, transport: ports.substrate.transport, navigateRoute, owner });

  const onPopState = () => application.navigate(`${location.pathname}${location.search}`);
  addEventListener('popstate', onPopState);
  addEventListener('pagehide', () => {
    removeEventListener('popstate', onPopState);
    mounted.dispose();
    application.dispose();
    ports.dispose();
  }, { once: true });
}
