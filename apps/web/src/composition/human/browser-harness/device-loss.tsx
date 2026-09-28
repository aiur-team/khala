import { createRoot } from 'react-dom/client';
import type { AuthPrincipal, DevicePort, DeviceView, IdentityPort } from '@khala/contracts/messaging/index';
import { createChannelAccessInboxController } from '../../../features/channel-access/controller';
import { createFakeJournal } from '../../../features/channel-access/fakes';
import { createHumanApplication } from '../application';
import { HumanApplicationScreen } from '../mount';
import { createHumanRouteCodec } from '../routes';
import '../../../brand/tokens.css';
import '../../../brand/fonts.css';
import '../../../shell/shell.css';
import '../../../features/channel-access/channel-access.css';

const alice: AuthPrincipal = { v: 1, ownerId: 'owner_alice' as never, providerIssuer: 'https://id.example',
  providerSubject: 'alice', verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' };
const bob: AuthPrincipal = { ...alice, ownerId: 'owner_bob' as never, providerSubject: 'bob', verifiedEmail: 'bob@example.test' };
let principal = alice;
let state: 'lost' | 'ready' | 'revoked' = new URLSearchParams(location.search).get('state') === 'ready' ? 'ready' : 'lost';
let reason: DeviceView['reason'] = state === 'ready' ? null : 'storage_cleared';
let activationCount = 0;
let inboxCount = 0;
const logoutHarness = new URLSearchParams(location.search).has('logout');
const hostedHarness = new URLSearchParams(location.search).has('hosted');
let signedOut = false;
let signOutCount = 0;
let stopCount = 0;
const listeners = new Set<(view: DeviceView) => void>();
const view = (): DeviceView => ({ deviceId: `device_${principal.ownerId}` as never, state, generation: 1, reason });
const identity: IdentityPort = {
  async current() { return signedOut ? { kind: 'signed_out' } : { kind: 'signed_in', principal }; },
  async beginSignIn() { return { kind: 'rejected', code: 'invalid_return_path' }; },
  async signOut() {
    signOutCount += 1;
    if (logoutHarness) await new Promise(resolve => setTimeout(resolve, 150));
    if (logoutHarness && signOutCount === 1) return { kind: 'unavailable', retryable: true };
    signedOut = true;
    return { kind: 'ok', value: null };
  },
};
const device: DevicePort = {
  async ensureReady() { activationCount += 1; return { kind: 'ok', value: view() }; },
  current: view,
  observe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async stop() { stopCount += 1; },
};
const routes = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });
const application = createHumanApplication({ identity, device, room: {} as never, admission: {} as never,
  limits: {} as never }, { initialPath: '/channels/room_1' });
createRoot(document.getElementById('app')!).render(
  <HumanApplicationScreen application={application} identity={identity} routes={routes}
    renderRoom={context => <p data-testid="live-room">Channel for {context.principal.ownerId}</p>}
    createChannelAccess={() => {
      inboxCount += 1;
      return createChannelAccessInboxController({ requests: createFakeJournal().port });
    }} capabilities={[]} mode={logoutHarness && !hostedHarness ? 'standalone' : 'hosted-content'} />,
);
application.navigate('/channels/room_1');

declare global { interface Window {
  __lossHarness: {
    setDevice(next: 'lost' | 'ready' | 'revoked', nextReason?: DeviceView['reason']): void;
    switchAccount(): void;
    activationCount(): number;
    inboxCount(): number;
    signOutCount(): number;
    stopCount(): number;
  };
} }
window.__lossHarness = {
  setDevice(next, nextReason) {
    state = next;
    reason = next === 'ready' ? null : nextReason ?? (next === 'revoked' ? 'revoked_by_owner' : 'storage_cleared');
    const current = view();
    for (const listener of listeners) listener(current);
    application.navigate('/channels/room_1');
  },
  switchAccount() {
    principal = bob;
    state = 'lost';
    reason = 'key_material_missing';
    application.navigate('/channels/room_1');
  },
  activationCount: () => activationCount,
  inboxCount: () => inboxCount,
  signOutCount: () => signOutCount,
  stopCount: () => stopCount,
};
