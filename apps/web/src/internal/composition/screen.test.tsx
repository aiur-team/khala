import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeContentLimits, type ChannelPort, type DeviceId, type OwnerId, type ParticipantId, type RoomId,
} from '@khala/contracts/messaging/index';
import type { LocalTransport, LocalTransportState } from '@khala/messaging/local/http/index';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from '../../composition/human/application';
import type { TimelineController, TimelineData } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import type { PendingSend } from '../../features/timeline/send';
import { createChannelAccessInboxController } from '../../features/channel-access/controller';
import { createFakeJournal } from '../../features/channel-access/fakes';
import { createFakeCatalog } from '../../features/channel-settings/fakes';
import { closedAdmission, localPrincipal, localViewer } from './ports';
import { TransportStatus, resumeCommand, sendBlockedReason } from './room';
import { createLocalRouteCodec } from './routes';
import { LocalApplicationScreen } from './screen';

const ORIGIN = 'http://127.0.0.1:4871';
const routes = createLocalRouteCodec(ORIGIN);
const human = { ownerId: 'owner_1' as OwnerId, participantId: 'participant_h' as ParticipantId, deviceId: 'device_h' as DeviceId };
const roomId = 'ch_1' as RoomId;
const limits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 16_384, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
  if (!decoded.ok) throw new Error('limits');
  return decoded.value;
})();

const room: ChannelPort = {
  create: vi.fn(), prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(() => new Promise<never>(() => {})),
  observe: vi.fn(() => () => undefined),
};

function transport(state: LocalTransportState): LocalTransport {
  return { current: () => state, subscribe: () => () => undefined, retry: vi.fn() };
}

function context(path: string): HumanRouteContext {
  return {
    identity: { current: vi.fn(), beginSignIn: vi.fn(), signOut: vi.fn() },
    device: { ensureReady: vi.fn(), current: vi.fn(), observe: () => () => undefined, stop: vi.fn() },
    room,
    admission: closedAdmission,
    limits,
    participant: () => localViewer(human),
    path,
    generation: 1,
    principal: localPrincipal(human),
    deviceView: { deviceId: human.deviceId, state: 'ready', generation: 1, reason: null },
    registerDisposer: disposer => disposer,
  };
}

function application(snapshot: HumanApplicationSnapshot): HumanApplicationHandle {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined, navigate: vi.fn(), dispose: vi.fn() };
}

function render(path: string, state: LocalTransportState = { kind: 'live' }, phase: 'ready' | 'signed_out' = 'ready'): string {
  const snapshot: HumanApplicationSnapshot = phase === 'ready'
    ? { phase: 'ready', path, context: context(path) }
    : { phase: 'signed_out', path, context: null };
  return renderToStaticMarkup(
    <LocalApplicationScreen
      application={application(snapshot)}
      routes={routes}
      transport={transport(state)}
      navigateRoute={vi.fn()}
      owner={{
        createChannelAccess: () => createChannelAccessInboxController({ requests: createFakeJournal().port }),
        settings: createFakeCatalog({ roomId }).port,
      }}
    />,
  );
}

const HOSTED_ONLY = ['Sign in', 'Join', 'Who can join', 'Copy link', 'Channel link', 'Recovery', 'recovery key', 'Invitee email'];

describe('LocalApplicationScreen', () => {
  it('WRONG-IMPLEMENTATION: /join?… is not-found with no Join or Sign-in UI', () => {
    const html = render('/join?invite=abc');
    expect(html).toContain('This local Khala page does not exist.');
    for (const text of HOSTED_ONLY) expect(html).not.toContain(text);
  });

  it('adds owner navigation to the channel-requests inbox with a settings link on each channel', () => {
    const html = render('/channels/ch_1');
    expect(html).toContain('href="/channel-requests"');
    expect(html).toContain('Channel requests');
    expect(html).toContain('href="/channels/ch_1/settings"');
  });

  it('renders the shared inbox and the shared settings panel on their own routes', () => {
    const requests = render('/channel-requests');
    expect(requests).toContain('khala-channel-requests-title');
    const settings = render('/channels/ch_1/settings');
    expect(settings).toContain('Channel discovery settings');
    expect(settings).toContain('href="/channels/ch_1"');
    for (const text of HOSTED_ONLY) expect(requests + settings).not.toContain(text);
  });

  it('renders no owner navigation for a refused session', () => {
    const html = render('/channel-requests', { kind: 'auth_failed' }, 'signed_out');
    expect(html).not.toContain('Channel requests');
  });

  it('renders private create without admission choice or share link', () => {
    const html = render('/');
    expect(html).toContain('Create a private local channel.');
    expect(html).toContain('Create channel');
    for (const text of HOSTED_ONLY) expect(html).not.toContain(text);
  });

  it('treats a refused session as terminal relaunch guidance, never a sign-in prompt', () => {
    const html = render('/channels/ch_1', { kind: 'auth_failed' }, 'signed_out');
    expect(html).toContain('This local session has ended');
    expect(html).toContain(resumeCommand('ch_1'));
    expect(html).not.toContain('Sign in');
    // The page offers no action: only a relaunch from the terminal can recover.
    expect(html.slice(html.indexOf('khala-page-frame__body'))).not.toContain('<button');
  });

  it('renders the channel with the viewer attribution and an initial load distinct from an empty channel', () => {
    const html = render('/channels/ch_1');
    expect(html).toContain('Local channel');
    expect(html).toContain('Loading conversation…');
    expect(html).not.toContain('No messages yet.');
  });

  it.each([
    [{ kind: 'connecting' } as const, 'Connecting to the local Khala server…', 'Sending starts once Khala connects'],
    [{ kind: 'reconnecting', attempt: 2 } as const, 'Reconnecting (attempt 2)', 'Sending is paused while Khala reconnects'],
    [{ kind: 'stopped' } as const, 'The local Khala server stopped', 'local server is not reachable'],
    [{ kind: 'channel_unavailable' } as const, 'This channel is not available', 'can no longer open this channel'],
    [{ kind: 'auth_failed' } as const, 'This local session has ended', 'this local session has ended'],
  ])('blocks sending and explains the %j transport state', (state, status, reason) => {
    const html = render('/channels/ch_1', state);
    expect(html).toContain(status);
    expect(html).toContain(reason);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*aria-describedby="timeline-send-blocked"/);
  });

  it('offers the exact resume command and a reconnect control once stopped', () => {
    const html = render('/channels/ch_1', { kind: 'stopped' });
    expect(html).toContain('khala internal --resume ch_1');
    expect(html).toContain('Try to reconnect');
    expect(html).toContain('role="alert"');
    expect(resumeCommand('~odd')).toBe("khala internal --resume '~odd'");
  });

  it('leaves sending enabled only while live', () => {
    expect(sendBlockedReason({ kind: 'live' })).toBeNull();
    for (const kind of ['connecting', 'stopped', 'channel_unavailable', 'auth_failed'] as const) expect(sendBlockedReason({ kind })).not.toBeNull();
    const live = renderToStaticMarkup(<TransportStatus state={{ kind: 'live' }} roomId="ch_1" onRetry={vi.fn()} />);
    expect(live).toContain('role="status"');
    expect(live).not.toContain('role="alert"');
  });
});

describe('local interaction-state matrix', () => {
  function controller(data: Partial<TimelineData>): TimelineController {
    const full: TimelineData = { phase: 'ready', items: [], nextCursor: null, newMessageCount: 0, membership: 'joined', ...data };
    return { getSnapshot: () => full, subscribe: () => () => undefined, loadOlder: async () => null, setReaderAtLatest: vi.fn(), dispose: vi.fn() };
  }
  const content = (body: string) => ({ v: 1 as const, kind: 'text' as const, body });
  function matrix(data: Partial<TimelineData>, pending: readonly PendingSend[] = [], blocked: string | null = null) {
    return renderToStaticMarkup(
      <TimelineScreen
        controller={controller(data)}
        roomPort={room}
        roomId={roomId}
        viewer={localViewer(human)}
        sendBlockedReason={blocked}
        pendingStore={{ load: () => pending, save: vi.fn() }}
      />,
    );
  }

  it('distinguishes the initial load from an empty channel', () => {
    expect(matrix({ phase: 'loading' })).toContain('Loading conversation…');
    expect(matrix({ phase: 'loading' })).not.toContain('No messages yet.');
    expect(matrix({ phase: 'ready' })).toContain('No messages yet.');
  });

  it('restores pending, failed and unknown sends after a reload with their safe controls', () => {
    const html = matrix({}, [
      { clientTxnId: 'txn_pending', content: content('interrupted'), phase: 'pending' },
      { clientTxnId: 'txn_failed', content: content('refused'), phase: 'failed' },
      { clientTxnId: 'txn_unknown', content: content('maybe'), phase: 'outcome_unknown' },
    ]);
    // A send interrupted by the reload may have landed, so it is never shown as still sending.
    expect(html).not.toContain('Sending…');
    expect(html.match(/Delivery unknown/g)).toHaveLength(2);
    expect(html.match(/Check delivery/g)).toHaveLength(2);
    expect(html).toContain('Not delivered');
    expect(html).toContain('>Retry<');
    expect(html).toContain('aria-live="polite"');
    // An unresolved send blocks a blind duplicate from the composer.
    expect(html).toMatch(/<button type="submit" disabled=""/);
  });

  it('disables retry and check-delivery while the transport is down', () => {
    const html = matrix({}, [{ clientTxnId: 'txn_failed', content: content('refused'), phase: 'failed' }], 'Sending is paused.');
    expect(html).toMatch(/<button type="button" disabled="">Retry<\/button>/);
    expect(html).toContain('Sending is paused.');
  });
});
