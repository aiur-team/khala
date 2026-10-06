import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AdmissionPort, DeviceId, DevicePort, DeviceView, IdentityPort, IdentityState, InviteState, OwnerId, RoomId,
} from '@khala/contracts/messaging/index';
import { ok, unavailable } from '@khala/contracts/messaging/index';
import { createJoinController } from '../../../features/join/controller';
import { JoinScreen } from '../../../features/join/JoinScreen';
import { ChannelSharePanel } from '../../../features/channel/ChannelSharePanel';
import { parseJoinLocation } from '../../../features/join/location';
import { createHumanRouteCodec } from '../routes';
import type { JoinPorts } from '../../../features/join/ports';

// Synthetic harness only: no real OAuth provider, no real admission service.
// Everything routes through `?page=oauth-mock` on the same origin so browser
// back/forward and viewport tests exercise real navigation without a network.

const params = new URLSearchParams(window.location.search);
document.body.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const ownerFromUrl = params.get('owner');
if (ownerFromUrl) localStorage.setItem('khala.test.owner', ownerFromUrl);
const signedInOwner = ownerFromUrl ?? localStorage.getItem('khala.test.owner');
const routeCodec = createHumanRouteCodec({ origin: window.location.origin, basePath: '/', allowInsecureLoopback: true });

function PersonalShare({ owner }: { owner: string }) {
  return <ChannelSharePanel admission={{ share: async () => unavailable() }} roomId={'room_1' as RoomId}
    channelLinks={{ personal: async () => ({ v: 1, kind: 'personal_link',
      shareUrl: `${window.location.origin}/join/${owner}`, expiresAt: null }) }} />;
}

function CreatedRoom() {
  return <main><h1>Test channel</h1><PersonalShare owner={signedInOwner ?? 'signed_out'} /></main>;
}

function readyDevice(): DeviceView {
  return { deviceId: 'device_1' as DeviceId, state: 'ready', generation: 1, reason: null };
}

function OAuthMock() {
  const returnPath = params.get('returnPath') ?? '/';
  const separator = returnPath.includes('?') ? '&' : '?';
  return (
    <div>
      <h1>Synthetic OAuth (harness only, not a real provider)</h1>
      <a id="oauth-continue" href={`${returnPath}${separator}identity=signed_in`}>
        Continue as test user
      </a>
    </div>
  );
}

function JoinRoute() {
  const identityState: IdentityState = params.get('identity') === 'signed_in' || signedInOwner !== null
    ? {
      kind: 'signed_in',
      principal: {
        v: 1,
        ownerId: (signedInOwner ?? 'owner_1') as OwnerId,
        providerIssuer: 'https://issuer.example',
        providerSubject: 'sub_1',
        verifiedEmail: params.get('email') ?? (signedInOwner
          ? `${signedInOwner}@example.test` : 'a.fairly.long.verified.person@a-long-workspace-example.example'),
        sessionExpiresAt: '2099-01-01T00:00:00Z',
      },
    }
    : { kind: 'signed_out' };

  const inviteState = (params.get('state') as InviteState | 'invalid_link' | null) ?? 'eligible';
  const deviceReady = params.get('device') !== 'failed';

  const [ports] = useState<JoinPorts>(() => ({
    identity: {
      current: async () => identityState,
      beginSignIn: async returnPath => ok({
        kind: 'navigate' as const,
        url: `${window.location.pathname}?page=oauth-mock&returnPath=${encodeURIComponent(returnPath)}`,
      }),
      signOut: async () => ok(null),
    } satisfies IdentityPort,
    device: {
      ensureReady: async () => deviceReady
        ? ok(readyDevice())
        : ok({ deviceId: null, state: 'failed', generation: 1, reason: 'initialization_failed' }),
      current: readyDevice,
      observe: () => () => {},
      stop: async () => {},
    } satisfies DevicePort,
    admission: {
      share: async () => unavailable(),
      inspect: async () => inviteState === 'invalid_link' ? 'unavailable' : inviteState,
      admit: async () => ok({ outcome: 'joined' as const, room: { roomId: 'room_1' as RoomId, title: params.get('title'), membership: 'joined' as const, revision: 'r1' } }),
    } satisfies AdmissionPort,
    channelLinks: {
      resolve: async () => ({ v: 1, kind: inviteState === 'eligible' ? 'join_required'
        : inviteState === 'already_joined' ? 'joined' : inviteState === 'identity_mismatch' ? 'forbidden'
          : inviteState === 'auth_required' ? 'auth_required' : inviteState }),
    },
    codec: { parseJoinLocation: location => location.startsWith('/join/')
      ? routeCodec.parseJoinLocation(location) : parseJoinLocation(location) },
    navigate: url => {
      window.location.href = url;
    },
  }));

  const [controller] = useState(() => createJoinController(ports));
  const [view, setView] = useState(controller.getView());

  useEffect(() => controller.subscribe(setView), [controller]);
  useEffect(() => {
    controller.start(`${window.location.pathname}${window.location.search}`);
  }, [controller]);

  return <><JoinScreen view={view} onSignIn={() => void controller.signIn()} onRetry={() => controller.retry()} />
    {view.phase === 'joined' ? <PersonalShare owner={identityState.kind === 'signed_in' ? identityState.principal.ownerId : 'signed_out'} /> : null}</>;
}

const root = createRoot(document.getElementById('root')!);
root.render(params.get('page') === 'oauth-mock' ? <OAuthMock /> : params.has('create') ? <CreatedRoom /> : <JoinRoute />);
