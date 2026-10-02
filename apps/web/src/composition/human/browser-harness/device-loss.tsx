import { createRoot } from 'react-dom/client';
import type { AuthPrincipal, DevicePort, DeviceView, IdentityPort, RoomId } from '@khala/contracts/messaging/index';
import { decodeContentLimits, ok } from '@khala/contracts/messaging/index';
import { createHumanApplication } from '../application';
import { HumanApplicationScreen } from '../mount';
import { createHumanRouteCodec } from '../routes';
import { ChannelScreen } from '../../../features/channel/ChannelScreen';
import { ChannelInvite } from '../../../features/channel/ChannelSharePanel';
import { ChatComposer, ChatMessage } from '../../../ui/conversation';
import '../../../brand/tokens.css';
import '../../../brand/fonts.css';
import '../../../shell/shell.css';
import '../../../features/channel/channel.css';

const alice: AuthPrincipal = { v: 1, ownerId: 'owner_alice' as never, providerIssuer: 'https://id.example',
  providerSubject: 'alice', verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' };
const bob: AuthPrincipal = { ...alice, ownerId: 'owner_bob' as never, providerSubject: 'bob', verifiedEmail: 'bob@example.test' };
let principal = alice;
let state: 'lost' | 'ready' | 'revoked' = new URLSearchParams(location.search).get('state') === 'ready' ? 'ready' : 'lost';
let reason: DeviceView['reason'] = state === 'ready' ? null : 'storage_cleared';
let activationCount = 0;
const logoutHarness = new URLSearchParams(location.search).has('logout');
const hostedHarness = new URLSearchParams(location.search).has('hosted');
const visualHarness = new URLSearchParams(location.search).has('visual');
const holdDeviceHarness = new URLSearchParams(location.search).has('hold-device');
const failDeviceHarness = new URLSearchParams(location.search).has('fail-device');
let releaseDevice: (() => void) | null = null;
const heldDevice = holdDeviceHarness ? new Promise<void>(resolve => { releaseDevice = resolve; }) : null;
let signedOut = false;
let signOutCount = 0;
let signInCount = 0;
let stopCount = 0;
let releaseIdentity: (() => void) | null = null;
let holdIdentity: Promise<void> | null = null;
const listeners = new Set<(view: DeviceView) => void>();
const view = (): DeviceView => ({ deviceId: `device_${principal.ownerId}` as never, state, generation: 1, reason });
const identity: IdentityPort = {
  async current() { if (holdIdentity) { await holdIdentity; holdIdentity = null; } return signedOut ? { kind: 'signed_out' } : { kind: 'signed_in', principal }; },
  async beginSignIn() { signInCount += 1; return { kind: 'rejected', code: 'invalid_return_path' }; },
  async signOut() {
    signOutCount += 1;
    if (logoutHarness) await new Promise(resolve => setTimeout(resolve, 150));
    if (logoutHarness && signOutCount === 1) return { kind: 'unavailable', retryable: true };
    signedOut = true;
    return { kind: 'ok', value: null };
  },
};
const device: DevicePort = {
  async ensureReady() {
    activationCount += 1;
    if (heldDevice) await heldDevice;
    return failDeviceHarness ? { kind: 'unavailable', retryable: true } : { kind: 'ok', value: view() };
  },
  current: view,
  observe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async stop() { stopCount += 1; },
};
const routes = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });
const conversations = {
  snapshot: () => [
    { id: 'room_1', title: 'First channel', preview: 'First message', timestamp: null, unreadCount: null },
    { id: 'room_2', title: 'Second channel', preview: 'Second message', timestamp: null, unreadCount: null },
  ],
  subscribe: () => () => undefined,
};
const limits =decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
if (!limits.ok) throw new Error('invalid harness limits');
// Creating from the New channel popover "creates" the second listed channel.
const room = { create: async ({ title }: { title: string | null }) => ok({ roomId: 'room_2' as RoomId, title, membership: 'joined' as const, revision: 'rev_created' }) };
const application = createHumanApplication({ identity, device, room: room as never, admission: {} as never, conversations,
  limits: limits.value },{ initialPath: holdDeviceHarness ? '/new' : '/channels/room_1' });
function VisualRoom({ onBack }: { onBack?: () => void }) {
  return <ChannelScreen title="First channel" viewerName="Alice" controller={visualController} {...(onBack ? { onBack } : {})}
    renderTimeline={() => <><ul className="fixture-messages"><ChatMessage id="hello" author="Alice">A shared place for the release.</ChatMessage></ul>
      <ChatComposer value="" onChange={() => {}} onSend={() => {}} /></>}
    renderShare={() => <ChannelInvite roomId={'room_1' as never} admission={{ share: async () => ({ kind: 'ok', value: { inviteRef: 'visual', shareUrl: 'https://khala.example/join/visual', expiresAt: null } }) }} />}
    />;
}
const visualSnapshot = { phase: 'ready' as const, agents: [] };
const visualController = { getSnapshot: () => visualSnapshot, subscribe: () => () => {}, dispose: () => {} };
createRoot(document.getElementById('app')!).render(
  <HumanApplicationScreen application={application} identity={identity} routes={routes}
    renderRoom={(context, route, navigate, codec) => {
      const onBack = navigate && codec ? () => navigate(codec.conversationsPath()) : undefined;
      return visualHarness ? <VisualRoom {...(onBack ? { onBack } : {})} /> : <div>
        {onBack ? <button type="button" className="kh-back" aria-label="All conversations" onClick={onBack}>‹</button> : null}
        <p data-testid="live-room">Channel for {context.principal.ownerId}: {route.roomId}</p>
      </div>;
    }}
    mode={logoutHarness && !hostedHarness ? 'standalone' : 'hosted-content'} />,
);
if (!holdDeviceHarness) application.navigate('/channels/room_1');

declare global { interface Window {
  __lossHarness: {
    setDevice(next: 'lost' | 'ready' | 'revoked', nextReason?: DeviceView['reason']): void;
    switchAccount(): void;
    activationCount(): number;
    signOutCount(): number;
    signInCount(): number;
    stopCount(): number;
    holdNavigation(): void;
    releaseNavigation(): void;
    releaseDevice(): void;
    navigate(path: string): void;
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
  signOutCount: () => signOutCount,
  signInCount: () => signInCount,
  stopCount: () => stopCount,
  holdNavigation() { holdIdentity = new Promise(resolve => { releaseIdentity = resolve; }); },
  releaseNavigation() { releaseIdentity?.(); releaseIdentity = null; },
  releaseDevice() { releaseDevice?.(); releaseDevice = null; },
  navigate(path) { application.navigate(path); },
};
