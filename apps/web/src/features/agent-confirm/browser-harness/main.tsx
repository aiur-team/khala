import { createRoot } from 'react-dom/client';
import { createHumanBrowserApi } from '../../../composition/human/browser-api';
import { createHumanRouteCodec } from '../../../composition/human/routes';
import { HumanApplicationScreen } from '../../../composition/human/mount';
import { AgentConfirmPage } from '../../../composition/human/confirm-page';
import { decodeContentLimits } from '@khala/contracts/messaging/index';
// The product entry's stylesheets (`src/main.tsx`), so the page renders as the app does.
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../../../main.css';
import type { HumanApplicationHandle, HumanApplicationSnapshot } from '../../../composition/human/application';

const limits = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 128, maxRoomTitleBytes: 256 });
if (!limits.ok) throw new Error('invalid fixture limits');
const routes = createHumanRouteCodec({ origin: location.origin, basePath: '/', allowInsecureLoopback: true });
const api = createHumanBrowserApi({ origin: location.origin, homeserverOrigin: location.origin, limits: limits.value, allowInsecureLoopback: true });
const root = createRoot(document.getElementById('app')!);
// `?path=` starts a signed-out app visit elsewhere, e.g. `/conversations` (the parity audit's §25.11 check).
const appPath = new URLSearchParams(location.search).get('path');
if (location.pathname.startsWith('/channels/')) {
  root.render(<p>Opened channel</p>);
} else if (appPath) {
  const snapshot: HumanApplicationSnapshot = { phase: 'signed_out', path: appPath, context: null };
  const application: HumanApplicationHandle = {
    getSnapshot: () => snapshot, subscribe: () => () => undefined, navigate: () => undefined,
    retryDevice: () => undefined, dispose: () => undefined, signOut: async () => ({ kind: 'unavailable', retryable: true }),
  };
  root.render(<HumanApplicationScreen application={application} identity={api.identity} routes={routes}
    renderRoom={() => null} navigateExternal={url => { location.href = url; }} />);
} else {
  // The production confirm entry: no application, Matrix client or device lock.
  root.render(<AgentConfirmPage identity={api.identity} agentJoin={api.agentJoin} profile={api.profile} routes={routes}
    joinId="j1" path={routes.agentConfirmPath('j1')} />);
}
