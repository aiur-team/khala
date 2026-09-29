import { createRoot } from 'react-dom/client';
import type { AuthPrincipal, DeviceId, OwnerId } from '@khala/contracts/messaging/index';
import { ok, unavailable } from '@khala/contracts/messaging/index';
import { createBrowserDeviceService, createIndexedDbMarkerStore, createIndexedDbStoreFactory,
  createWebLockProvider } from '@khala/messaging/browser-device/index';
import { createHumanApplication } from '../application';
import { HumanApplicationScreen } from '../mount';
import { createHumanRouteCodec } from '../routes';
import { createBrowserTabHandoff } from '../tab-handoff';
import { createChannelAccessInboxController } from '../../../features/channel-access/controller';
import { createFakeJournal } from '../../../features/channel-access/fakes';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';

const principal: AuthPrincipal = { v: 1, ownerId: 'owner_alice' as OwnerId, providerIssuer: 'https://id.example',
  providerSubject: 'alice', verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' };
const params = new URLSearchParams(location.search);
const initialPath = params.get('path') ?? '/new';
history.replaceState(null, '', initialPath);
const tabId = crypto.randomUUID();
let stopGate: Promise<void> | null = null;
let releaseStop: (() => void) | null = null;
let releaseSync: (() => void) | null = null;
const syncGate = params.has('holdSync') ? new Promise<void>(resolve => { releaseSync = resolve; }) : null;
const identity = {
  async current() { return { kind: 'signed_in' as const, principal }; },
  async beginSignIn() { return unavailable(); },
  async signOut() { return ok(null); },
};
const device = createBrowserDeviceService({
  identity,
  credentials: { async resolve() { return { kind: 'ok' as const, session: {
    deviceId: 'DEVICE_A' as DeviceId, publishedFingerprint: 'test-fingerprint', credentials: null,
  } }; } },
  stores: createIndexedDbStoreFactory(),
  markers: createIndexedDbMarkerStore(),
  locks: createWebLockProvider(),
  lockWaitMs: 350,
  engines: { async open() {
    // The marker checks the production store/engine close order across tabs.
    if (localStorage.getItem('active-device-tab')) localStorage.setItem('overlapping-generations', 'true');
    localStorage.setItem('active-device-tab', tabId);
    return {
      async identity() { return { fingerprint: 'test-fingerprint', created: false }; },
      async start() { await syncGate; await new Promise(resolve => setTimeout(resolve, 100)); }, // initial sync
      async close() {
        await stopGate;
        if (localStorage.getItem('active-device-tab') === tabId) localStorage.removeItem('active-device-tab');
      },
    };
  } },
});
const routes = createHumanRouteCodec({ origin: location.origin, basePath: '/', allowInsecureLoopback: true });
const application = createHumanApplication({ identity, device, room: {} as never, admission: {} as never,
  conversations: { snapshot: () => [], subscribe: () => () => undefined }, limits: {} as never },
{ initialPath, tabHandoff: createBrowserTabHandoff() });
createRoot(document.getElementById('app')!).render(<HumanApplicationScreen application={application} identity={identity}
  routes={routes} renderRoom={() => <p data-testid="live-room">Encrypted channel is ready</p>}
  createChannelAccess={() => createChannelAccessInboxController({ requests: createFakeJournal().port })}
  capabilities={[]} mode="hosted-content" />);
window.addEventListener('pagehide', () => {
  if (localStorage.getItem('active-device-tab') === tabId) localStorage.removeItem('active-device-tab');
  application.dispose();
});
declare global { interface Window { __tabHandoff: {
  phase(): string;
  generation(): number;
  holdStop(): void;
  releaseStop(): void;
  releaseSync(): void;
  overlap(): boolean;
}; } }
window.__tabHandoff = {
  phase: () => application.getSnapshot().phase,
  generation: () => device.current().generation,
  holdStop() { stopGate = new Promise(resolve => { releaseStop = resolve; }); },
  releaseStop() { releaseStop?.(); releaseStop = null; stopGate = null; },
  releaseSync() { releaseSync?.(); releaseSync = null; },
  overlap: () => localStorage.getItem('overlapping-generations') === 'true',
};
