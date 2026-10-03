// The local owner app on fake ports: the real application lifecycle and screen,
// with the local identity's two answers (`signed_in`, `unavailable`).
// `?down` the helper is unreachable, `?signed-out` the browser has no owner
// session, `?gone` opens a channel the owner can no longer open, `?oauth`
// renders the same fixture as the hosted account for comparison.
import { createRoot } from 'react-dom/client';
import type { AuthPrincipal, DevicePort, DeviceView, IdentityPort, ParticipantView, RoomId } from '@khala/contracts/messaging/index';
import { decodeContentLimits, ok } from '@khala/contracts/messaging/index';
import type { ProfilePort } from '../../../features/profile/ports';
import { createHumanApplication } from '../application';
import { HumanApplicationScreen } from '../mount';
import { renderHumanRoom } from '../room';
import { createHumanRouteCodec } from '../routes';
import '../../../brand/tokens.css';
import '../../../brand/fonts.css';
import '../../../shell/shell.css';
import '../../../features/channel/channel.css';
import '../../../main.css';

const query = new URLSearchParams(location.search);
const principal: AuthPrincipal = { v: 1, ownerId: 'local-owner' as never, providerIssuer: 'khala-local', providerSubject: 'owner',
  verifiedEmail: '', sessionExpiresAt: '9999-12-31T23:59:59.000Z' };
let signInCount = 0;
let signOutCount = 0;
const identity: IdentityPort = {
  async current() {
    if (query.has('down')) return { kind: 'unavailable', retryable: true };
    if (query.has('signed-out')) return { kind: 'signed_out' };
    return { kind: 'signed_in', principal };
  },
  async beginSignIn() { signInCount += 1; return { kind: 'rejected', code: 'invalid_return_path' }; },
  async signOut() { signOutCount += 1; return { kind: 'ok', value: null }; },
};
const view: DeviceView = { deviceId: 'KH_LOCAL_OWNER' as never, state: 'ready', generation: 1, reason: null };
const device: DevicePort = {
  async ensureReady() { return { kind: 'ok', value: view }; },
  current: () => view,
  observe: () => () => undefined,
  async stop() {},
};
const profile: ProfilePort = {
  async get() { return { kind: 'ok', username: 'kevin', suggestion: 'kevin', color: 'blue', initials: null }; },
  async setUsername(username) { return { kind: 'ok', username }; },
  async setColor(color) { return { kind: 'ok', color }; },
  async setInitials(initials) { return { kind: 'ok', initials }; },
};
const conversations = {
  snapshot: () => [
    { id: '!refactor0000000000000000:local', title: 'refactor', preview: '@kevin-Codex can you review PR #12?', timestamp: null, unreadCount: null },
    { id: '!release00000000000000000:local', title: 'release', preview: null, timestamp: null, unreadCount: null },
  ],
  subscribe: () => () => undefined,
};
const viewer: ParticipantView = { participantId: '@khala_owner:local' as never, kind: 'human', ownerId: 'local-owner' as never,
  displayName: 'kevin', deviceIds: ['KH_LOCAL_OWNER' as never] } as ParticipantView;
const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
if (!limits.ok) throw new Error('invalid harness limits');
const room = {
  timeline: async () => ({ kind: 'unavailable', retryable: true }),
  observe: () => () => undefined,
  create: async ({ title }: { title: string | null }) => ok({ roomId: '!release00000000000000000:local' as RoomId, title,
    membership: 'joined' as const, revision: 'rev_created' }),
};
const routes = createHumanRouteCodec({ origin: location.origin, basePath: '/', allowInsecureLoopback: true });
const application = createHumanApplication({ identity, device, room: room as never, admission: {} as never, conversations, profile,
  participant: () => viewer, limits: limits.value },
{ initialPath: query.has('gone') ? '/channels/!gone00000000000000000000:local' : routes.conversationsPath() });
createRoot(document.getElementById('app')!).render(
  <HumanApplicationScreen application={application} identity={identity} routes={routes} renderRoom={renderHumanRoom}
    account={query.has('oauth') ? 'oauth' : 'local_owner'} />,
);
application.navigate(query.has('gone') ? '/channels/!gone00000000000000000000:local' : routes.conversationsPath());

declare global { interface Window {
  __localOwner: { signInCount(): number; signOutCount(): number; copied: string[] };
} }
window.__localOwner = { ...window.__localOwner, signInCount: () => signInCount, signOutCount: () => signOutCount,
  copied: window.__localOwner?.copied ?? [] };
