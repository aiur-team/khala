import { decodeContentLimits } from '@khala/contracts/messaging/index';
import { createHumanApplication } from './composition/human/application';
import { mountKhalaContent } from './composition/human/mount';
import { renderHumanRoom } from './composition/human/room';
import { createHumanRouteCodec } from './composition/human/routes';
import { createLocalHumanPorts, localInitialPath } from './composition/local/ports';
import './brand/fonts.css';
import './brand/tokens.css';
import './shell/shell.css';
import './features/create-channel/create-channel.css';
import './features/timeline/timeline.css';
import './features/channel/channel.css';
import './main.css';

const target = document.querySelector('#app');
if (!target) throw new Error('missing Khala application mount');
const decodedLimits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
if (!decodedLimits.ok) throw new Error('invalid local content limits');
const initialPath = localInitialPath(location);
if (initialPath !== `${location.pathname}${location.search}`) history.replaceState(null, '', initialPath);
const ports = createLocalHumanPorts({ origin: location.origin, limits: decodedLimits.value });
const application = createHumanApplication(ports, { initialPath });
const routes = createHumanRouteCodec({ origin: location.origin, basePath: '/', allowInsecureLoopback: true });
const mounted = mountKhalaContent({
  target, application, identity: ports.identity, routes, mode: 'standalone', account: 'local_owner', renderRoom: renderHumanRoom,
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
  ports.dispose();
}, { once: true });
