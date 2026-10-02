import { createRoot } from 'react-dom/client';
import { createHumanBrowserApi } from '../../../composition/human/browser-api';
import { createHumanRouteCodec } from '../../../composition/human/routes';
import { HumanApplicationScreen } from '../../../composition/human/mount';
import { decodeContentLimits } from '@khala/contracts/messaging/index';
// The product entry's stylesheets (`src/main.tsx`), so the page renders as the app does.
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../../../main.css';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from '../../../composition/human/application';

const limits = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 128, maxRoomTitleBytes: 256 });
if (!limits.ok) throw new Error('invalid fixture limits');
const routes = createHumanRouteCodec({ origin: location.origin, basePath: '/', allowInsecureLoopback: true });
const api = createHumanBrowserApi({ origin: location.origin, homeserverOrigin: location.origin, limits: limits.value, allowInsecureLoopback: true });
// The route the human asked for; it renders once a username is saved. `?list`
// asks for the conversations list, whose brand row a phone also shows.
const path = new URLSearchParams(location.search).has('list') ? routes.conversationsPath() : routes.roomPath('!r1:khala.local');
const context = {
  path, principal: { ownerId: 'owner_alice' }, profile: api.profile,
  registerDisposer: () => () => undefined,
} as unknown as HumanRouteContext;
const snapshot: HumanApplicationSnapshot = { phase: 'ready', path, context };
const application: HumanApplicationHandle = {
  getSnapshot: () => snapshot, subscribe: () => () => undefined, navigate: () => undefined,
  retryDevice: () => undefined, dispose: () => undefined, signOut: async () => ({ kind: 'unavailable', retryable: true }),
};
createRoot(document.getElementById('app')!).render(<HumanApplicationScreen application={application} identity={api.identity}
  routes={routes} renderRoom={() => <p>Opened channel</p>} />);
