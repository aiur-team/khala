import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AdmissionPort, DeviceId, DevicePort, DeviceView, IdentityPort, IdentityState, InviteState, OwnerId, RoomId,
} from '@khala/contracts/messaging/index';
import { ok, unavailable } from '@khala/contracts/messaging/index';
import { createJoinController } from '../controller';
import { JoinScreen } from '../JoinScreen';
import { parseJoinLocation } from '../location';
import type { JoinPorts } from '../ports';

// Synthetic harness only: no real OAuth provider, no real admission service.
// Everything routes through `?page=oauth-mock` on the same origin so browser
// back/forward and viewport tests exercise real navigation without a network.

const params = new URLSearchParams(window.location.search);

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
  const identityState: IdentityState = params.get('identity') === 'signed_in'
    ? {
      kind: 'signed_in',
      principal: {
        v: 1,
        ownerId: 'owner_1' as OwnerId,
        providerIssuer: 'https://issuer.example',
        providerSubject: 'sub_1',
        verifiedEmail: params.get('email') ?? 'a.fairly.long.verified.person@a-long-workspace-example.example',
        sessionExpiresAt: '2099-01-01T00:00:00Z',
      },
    }
    : { kind: 'signed_out' };

  const inviteState = (params.get('state') as InviteState | null) ?? 'eligible';
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
      inspect: async () => inviteState,
      admit: async () => ok({ outcome: 'joined' as const, room: { roomId: 'room_1' as RoomId, title: null, membership: 'joined' as const, revision: 'r1' } }),
    } satisfies AdmissionPort,
    codec: { parseJoinLocation },
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

  return <JoinScreen view={view} onSignIn={() => void controller.signIn()} onRetry={() => controller.retry()} />;
}

const root = createRoot(document.getElementById('root')!);
root.render(params.get('page') === 'oauth-mock' ? <OAuthMock /> : <JoinRoute />);
