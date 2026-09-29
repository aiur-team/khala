import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AdmissionPort,
  Admission,
  ContentLimits,
  DeviceView,
  DevicePort,
  IdentityPort,
  IdentityState,
  InviteState,
  OperationResult,
  ChannelPort,
  ChannelSummary,
  ShareGrant,
  TimelinePage,
  SendState,
} from '@khala/contracts/messaging/index';
import { decodeContentLimits, ok, unavailable } from '@khala/contracts/messaging/index';
import { CreateChannelScreen } from './CreateChannelScreen';
import { createCreateChannelController } from './controller';
import type { CreateChannelPorts } from './ports';

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {});
}

const NEW_DEVICE: DeviceView = { deviceId: null, state: 'new', generation: 0, reason: null };

const LIMITS: ContentLimits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 64, maxRoomTitleBytes: 128 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

function fakePorts(): CreateChannelPorts {
  const identity: IdentityPort = {
    current: vi.fn(() => pendingPromise<IdentityState>()),
    beginSignIn: vi.fn(() => pendingPromise<OperationResult<{ kind: 'navigate'; url: string }, 'invalid_return_path'>>()),
    signOut: vi.fn(() => pendingPromise<OperationResult<null, never>>()),
  };
  const device: DevicePort = {
    ensureReady: vi.fn(() => pendingPromise<OperationResult<DeviceView, never>>()),
    current: vi.fn(() => NEW_DEVICE),
    observe: vi.fn(() => () => {}),
    stop: vi.fn(() => pendingPromise<void>()),
  };
  const room: ChannelPort = {
    create: vi.fn(() => pendingPromise<OperationResult<ChannelSummary, never>>()),
    prepareIntro: vi.fn(() => pendingPromise<OperationResult<readonly SendState[], never>>()),
    resumeIntro: vi.fn(() => pendingPromise<OperationResult<readonly SendState[], never>>()),
    send: vi.fn(() => pendingPromise<OperationResult<SendState, never>>()),
    timeline: vi.fn(() => pendingPromise<OperationResult<TimelinePage, never>>()),
    observe: vi.fn(() => () => {}),
  };
  const admission: AdmissionPort = {
    share: vi.fn(() => pendingPromise<OperationResult<ShareGrant, never>>()),
    inspect: vi.fn(() => pendingPromise<InviteState>()),
    admit: vi.fn(() => pendingPromise<OperationResult<Admission, never>>()),
  };
  return { identity, device, room, admission, limits: LIMITS };
}

describe('CreateChannelScreen initial render', () => {
  it('labels the title field without introduction controls', () => {
    const html = renderToStaticMarkup(<CreateChannelScreen ports={fakePorts()} />);
    expect(html).toContain('for="create-channel-title"');
    expect(html).not.toContain('Introduction messages');
  });

  it('offers supported admission policies and defaults to a no-history link', () => {
    const html = renderToStaticMarkup(<CreateChannelScreen ports={fakePorts()} />);
    expect(html).toContain('<legend>Who can join from this link?</legend>');
    expect(html).toMatch(/<input(?=[^>]*\btype="radio")(?=[^>]*\bvalue="link_no_history")(?=[^>]*\bchecked="")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*\btype="radio")(?=[^>]*\bvalue="named_no_history")[^>]*>/);
    expect(html).not.toContain('value="link_full_history"');
    expect(html).toContain('Reading messages from before joining is currently unavailable.');
  });

  it('disables submit while readiness is still being checked, and shows no share link or error yet', () => {
    const html = renderToStaticMarkup(<CreateChannelScreen ports={fakePorts()} />);
    expect(html).toContain('type="submit" disabled=""');
    expect(html).not.toContain('create-channel__share');
    expect(html).not.toContain('role="alert"');
  });

});

describe('CreateChannelScreen with a pre-driven controller', () => {
  it('shows an email field and validation error for the named-recipient policy', () => {
    const controller = createCreateChannelController({
      room: { create: vi.fn(), prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(), observe: vi.fn(() => () => {}) },
      admission: { share: vi.fn(), inspect: vi.fn(), admit: vi.fn() },
      limits: LIMITS,
    });
    controller.setAdmissionPolicy('named_no_history');
    controller.submit();

    const html = renderToStaticMarkup(<CreateChannelScreen ports={fakePorts()} controller={controller} />);
    expect(html).toContain('for="create-channel-policy-email"');
    expect(html).toContain('Enter a valid email address.');
  });

  it('attaches the error to an alert and offers retry once a rejection lands', async () => {
    const create = vi.fn().mockResolvedValue({ kind: 'rejected', code: 'invalid_request' });
    const controller = createCreateChannelController({
      room: { create, prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(), observe: vi.fn(() => () => {}) },
      admission: { share: vi.fn(), inspect: vi.fn(), admit: vi.fn() },
      limits: LIMITS,
    });
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));

    const html = renderToStaticMarkup(<CreateChannelScreen ports={fakePorts()} controller={controller} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('invalid_request');
  });

  it('identifies a failed share and keeps the created channel reachable', async () => {
    const roomId = 'room_1' as ChannelSummary['roomId'];
    const controller = createCreateChannelController({
      room: { create: vi.fn().mockResolvedValue(ok({ roomId, title: null, membership: 'joined', revision: 'rev_1' })), prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(), observe: vi.fn(() => () => {}) },
      admission: { share: vi.fn().mockResolvedValue(unavailable()), inspect: vi.fn(), admit: vi.fn() },
      limits: LIMITS,
    });
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));

    const html = renderToStaticMarkup(<CreateChannelScreen ports={fakePorts()} controller={controller} onOpenRoom={() => {}} />);
    expect(html).toContain('Could not prepare the share link (unavailable).');
    expect(html).toContain('>Open created channel</button>');
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('introduction');
  });
});
