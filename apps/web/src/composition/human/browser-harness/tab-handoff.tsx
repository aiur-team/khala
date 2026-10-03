import { createRoot } from 'react-dom/client';
import type { AuthPrincipal, DeviceId, OwnerId } from '@khala/contracts/messaging/index';
import { ok, unavailable } from '@khala/contracts/messaging/index';
import { createBrowserDeviceService, createIndexedDbMarkerStore, createIndexedDbStoreFactory,
  createWebLockProvider } from '@khala/messaging/browser-device/index';
import { createHumanApplication } from '../application';
import { HumanApplicationScreen } from '../mount';
import { createHumanRouteCodec } from '../routes';
import { createBrowserTabHandoff } from '../tab-handoff';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';

const principal: AuthPrincipal = { v: 1, ownerId: 'owner_alice' as OwnerId, providerIssuer: 'https://id.example',
  providerSubject: 'alice', verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' };
const params = new URLSearchParams(location.search);
const initialPath = params.get('path') ?? '/new';
history.replaceState(null, '', initialPath);
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
    const engineId = crypto.randomUUID();
    // Acknowledge lifecycle events in the shared test process. Web Lock release
    // does not wait for another renderer to observe a localStorage mutation.
    await window.__recordDeviceEngine('opened', engineId);
    return {
      async identity() { return { fingerprint: 'test-fingerprint', created: false }; },
      async start() { await syncGate; },
      async close() {
        await stopGate;
        await window.__recordDeviceEngine('closed', engineId);
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
  mode="hosted-content" />);
window.addEventListener('pagehide', () => {
  application.dispose();
});
declare global { interface Window {
  __recordDeviceEngine(event: 'opened' | 'closed', engineId: string): Promise<void>;
  __tabHandoff: {
    phase(): string;
    whenPhase(phase: string): Promise<void>;
    generation(): number;
    holdStop(): void;
    releaseStop(): void;
    releaseSync(): void;
  };
} }
window.__tabHandoff = {
  phase: () => application.getSnapshot().phase,
  whenPhase(phase) {
    return new Promise(resolve => {
      const check = () => {
        if (application.getSnapshot().phase !== phase) return;
        unsubscribe();
        resolve();
      };
      const unsubscribe = application.subscribe(check);
      check();
    });
  },
  generation: () => device.current().generation,
  holdStop() { stopGate = new Promise(resolve => { releaseStop = resolve; }); },
  releaseStop() { releaseStop?.(); releaseStop = null; stopGate = null; },
  releaseSync() { releaseSync?.(); releaseSync = null; },
};
