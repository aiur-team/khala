import { createRoot } from 'react-dom/client';
import { AgentConfirm } from '../AgentConfirm';
import { createAgentConfirmController } from '../controller';
import { createHumanBrowserApi } from '../../../composition/human/browser-api';
import { createHumanRouteCodec } from '../../../composition/human/routes';
import { HumanApplicationScreen } from '../../../composition/human/mount';
import { decodeContentLimits } from '@khala/contracts/messaging/index';
import type { HumanApplicationHandle, HumanApplicationSnapshot } from '../../../composition/human/application';

const limits = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 128, maxRoomTitleBytes: 256 });
if (!limits.ok) throw new Error('invalid fixture limits');
const routes = createHumanRouteCodec({ origin: location.origin, basePath: '/', allowInsecureLoopback: true });
const api = createHumanBrowserApi({ origin: location.origin, homeserverOrigin: location.origin, limits: limits.value, allowInsecureLoopback: true });
const root = createRoot(document.getElementById('app')!);
const path = routes.agentConfirmPath('j1');
if (location.search.includes('signedOut')) {
  const snapshot: HumanApplicationSnapshot = { phase: 'signed_out', path, context: null };
  const application: HumanApplicationHandle = {
    getSnapshot: () => snapshot, subscribe: () => () => undefined, navigate: () => undefined,
    retryDevice: () => undefined, dispose: () => undefined, signOut: async () => ({ kind: 'unavailable', retryable: true }),
  };
  root.render(<HumanApplicationScreen application={application} identity={api.identity} routes={routes}
    renderRoom={() => null} navigateExternal={url => { location.href = url; }} />);
} else {
  const controller = createAgentConfirmController({ joinId: 'j1', port: api.agentJoin,
    invite: async (roomId, userId) => {
      await fetch('/fixture/invite', { method: 'POST', body: JSON.stringify({ roomId, userId }) });
      return true;
    } });
  root.render(<AgentConfirm controller={controller} roomHref={routes.roomPath}
    onOpenRoom={roomId => { history.pushState(null, '', routes.roomPath(roomId)); }} />);
  controller.start();
  addEventListener('pagehide', () => controller.dispose(), { once: true });
}
