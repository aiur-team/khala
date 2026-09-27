import { decodeContentLimits } from '@khala/contracts/messaging/index';
import { createHumanApplication } from './composition/human/application';
import { createHumanBrowserApi } from './composition/human/browser-api';
import { readHumanEntry } from './composition/human/entry';
import { readHostedConfig } from './composition/human/hosted-config';
import { createMatrixBrowserPorts } from './composition/human/matrix-browser';
import { mountKhalaContent } from './composition/human/mount';
import { renderHumanRoom } from './composition/human/room';
import { createHumanRouteCodec } from './composition/human/routes';
import { mountHostedUnavailable } from './composition/human/unavailable';
import { createChannelAccessInboxController } from './features/channel-access/controller';
import './brand/fonts.css';
import './brand/tokens.css';
import './shell/shell.css';
import './features/create-channel/create-channel.css';
import './features/timeline/timeline.css';
import './features/channel/channel.css';
import './features/approval-decision/approval-decision.css';
import './features/channel-access/channel-access.css';
import './main.css';

const target = document.querySelector('#app');
if (!target) throw new Error('missing Khala application mount');

// A deployment without its public origins renders an explicit unavailable
// screen; throwing here would leave the visitor a blank page.
const config = readHostedConfig(import.meta.env);
if (config.ok) startHostedApplication(target, config.appOrigin, config.homeserverOrigin);
else mountHostedUnavailable(target, config.missing);

function startHostedApplication(target: Element, appOrigin: string, homeserverOrigin: string): void {
  const decodedLimits = decodeContentLimits({
    maxBodyBytes: 32_768,
    maxDisplayNameBytes: 255,
    maxRoomTitleBytes: 255,
  });
  if (!decodedLimits.ok) throw new Error('invalid Matrix content limits');

  const entry = readHumanEntry(location);
  if (entry.path !== `${location.pathname}${location.search}`) history.replaceState(null, '', entry.path);

  const api = createHumanBrowserApi({ origin: appOrigin, homeserverOrigin, limits: decodedLimits.value });
  const matrix = createMatrixBrowserPorts({
    identity: api.identity,
    credentials: api.credentials,
    participants: api.participants,
    limits: decodedLimits.value,
  });
  const application = createHumanApplication({
    identity: api.identity,
    device: matrix.device,
    room: matrix.room,
    admission: api.admission,
    participant: matrix.participant,
    limits: decodedLimits.value,
  }, { initialPath: entry.path });
  const routes = createHumanRouteCodec({ origin: appOrigin, basePath: '/' });
  const createChannelAccess = () => createChannelAccessInboxController({ requests: api.channelAccess });
  const mounted = mountKhalaContent({
    target,
    application,
    identity: api.identity,
    routes,
    createChannelAccess,
    mode: entry.mode,
    renderRoom: renderHumanRoom,
    navigateRoute(path) {
      history.pushState(null, '', path);
      application.navigate(path);
    },
  });

  const onPopState = () => application.navigate(`${location.pathname}${location.search}`);
  addEventListener('popstate', onPopState);
  addEventListener('pagehide', () => {
    removeEventListener('popstate', onPopState);
    mounted.dispose();
    application.dispose();
  }, { once: true });
}
