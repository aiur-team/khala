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
const root = createRoot(document.getElementById('app')!);
// `?path=` starts a signed-out visit elsewhere, e.g. `/conversations` (the parity audit's §25.11 check).
const path = new URLSearchParams(location.search).get('path') ?? routes.agentConfirmPath('j1');
if (location.search.includes('signedOut')) {
  const snapshot: HumanApplicationSnapshot = { phase: 'signed_out', path, context: null };
  const application: HumanApplicationHandle = {
    getSnapshot: () => snapshot, subscribe: () => () => undefined, navigate: () => undefined,
    retryDevice: () => undefined, dispose: () => undefined, signOut: async () => ({ kind: 'unavailable', retryable: true }),
  };
  root.render(<HumanApplicationScreen application={application} identity={api.identity} routes={routes}
    renderRoom={() => null} navigateExternal={url => { location.href = url; }} />);
} else {
  const listeners = new Set<() => void>();
  const disposers = new Set<() => void>();
  const context = {
    path, principal: { ownerId: 'owner_alice' }, agentJoin: api.agentJoin,
    inviteAgent: async (roomId: string, userId: string) => {
      await fetch('/fixture/invite', { method: 'POST', body: JSON.stringify({ roomId, userId }) });
      return true;
    },
    registerDisposer(dispose: () => void) {
      disposers.add(dispose);
      return () => { if (disposers.delete(dispose)) dispose(); };
    },
  } as HumanRouteContext;
  let snapshot: HumanApplicationSnapshot = { phase: 'ready', path, context };
  const application: HumanApplicationHandle = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    navigate(nextPath) {
      for (const dispose of disposers) dispose();
      disposers.clear();
      snapshot = { phase: 'ready', path: nextPath, context: { ...context, path: nextPath } };
      for (const listener of listeners) listener();
    },
    retryDevice: () => undefined, dispose: () => { for (const dispose of disposers) dispose(); },
    signOut: async () => ({ kind: 'unavailable', retryable: true }),
  };
  root.render(<HumanApplicationScreen application={application} identity={api.identity} routes={routes}
    renderRoom={() => <p>Opened channel</p>} navigateRoute={nextPath => {
      history.pushState(null, '', nextPath);
      application.navigate(nextPath);
    }} />);
  addEventListener('pagehide', () => application.dispose(), { once: true });
}
