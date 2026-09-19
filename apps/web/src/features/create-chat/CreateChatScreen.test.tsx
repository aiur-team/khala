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
  RoomPort,
  RoomSummary,
  ShareGrant,
  TimelinePage,
  SendState,
} from '@khala/contracts/messaging/index';
import { decodeContentLimits } from '@khala/contracts/messaging/index';
import { CreateChatScreen } from './CreateChatScreen';
import { createChatController } from './controller';
import type { CreateChatPorts } from './ports';

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {});
}

const NEW_DEVICE: DeviceView = { deviceId: null, state: 'new', generation: 0, reason: null };

const LIMITS: ContentLimits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 4096, maxDisplayNameBytes: 64, maxRoomTitleBytes: 128 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();

function fakePorts(): CreateChatPorts {
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
  const room: RoomPort = {
    create: vi.fn(() => pendingPromise<OperationResult<RoomSummary, never>>()),
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

describe('CreateChatScreen initial render', () => {
  it('labels the title field, the intro fieldset and every intro control with an accessible name', () => {
    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} />);
    expect(html).toContain('for="create-chat-title"');
    expect(html).toContain('<legend>Introduction messages</legend>');
    expect(html).toContain('>Add introduction message<');
  });

  it('offers all three admission policies and defaults to a no-history link', () => {
    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} />);
    expect(html).toContain('<legend>Who can join from this link?</legend>');
    expect(html).toMatch(/<input(?=[^>]*\btype="radio")(?=[^>]*\bvalue="link_no_history")(?=[^>]*\bchecked="")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*\btype="radio")(?=[^>]*\bvalue="named_no_history")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*\btype="radio")(?=[^>]*\bvalue="link_full_history")[^>]*>/);
  });

  it('disables submit while readiness is still being checked, and shows no share link or error yet', () => {
    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} />);
    expect(html).toContain('type="submit" disabled=""');
    expect(html).not.toContain('create-chat__share');
    expect(html).not.toContain('role="alert"');
  });

  it('the empty-state intro list renders as a real, empty <ol>', () => {
    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} />);
    expect(html).toContain('<ol class="create-chat__intro-list"></ol>');
  });
});

describe('CreateChatScreen with a pre-driven controller', () => {
  it('shows an email field and validation error for the named-recipient policy', () => {
    const controller = createChatController({
      room: { create: vi.fn(), prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(), observe: vi.fn(() => () => {}) },
      admission: { share: vi.fn(), inspect: vi.fn(), admit: vi.fn() },
      limits: LIMITS,
    });
    controller.setAdmissionPolicy('named_no_history');
    controller.submit();

    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} controller={controller} />);
    expect(html).toContain('for="create-chat-policy-email"');
    expect(html).toContain('Enter a valid email address.');
  });

  it('names every intro row by position and disables move-up on the first, move-down on the last', () => {
    const controller = createChatController({
      room: { create: vi.fn(), prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(), observe: vi.fn(() => () => {}) },
      admission: { share: vi.fn(), inspect: vi.fn(), admit: vi.fn() },
      limits: LIMITS,
    });
    controller.addIntro();
    controller.addIntro();
    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} controller={controller} />);

    expect(html).toContain('>Message 1<');
    expect(html).toContain('>Message 2<');
    expect(html).toContain('>Move message 1 up<');
    expect(html).toContain('>Remove message 1<');
    expect(html).toContain('>Remove message 2<');
    // Move-up on the first row and move-down on the last row are both disabled.
    const rows = html.split('<li class="create-chat__intro-item">').slice(1);
    expect(rows[0]).toMatch(/Move message 1 up<\/button>/);
    expect(rows[0]!.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(1);
    expect(rows[1]).toMatch(/Move message 2 down<\/button>/);
  });

  it('attaches the error to an alert and offers retry once a rejection lands', async () => {
    const create = vi.fn().mockResolvedValue({ kind: 'rejected', code: 'invalid_request' });
    const controller = createChatController({
      room: { create, prepareIntro: vi.fn(), resumeIntro: vi.fn(), send: vi.fn(), timeline: vi.fn(), observe: vi.fn(() => () => {}) },
      admission: { share: vi.fn(), inspect: vi.fn(), admit: vi.fn() },
      limits: LIMITS,
    });
    controller.submit();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('failed'));

    const html = renderToStaticMarkup(<CreateChatScreen ports={fakePorts()} controller={controller} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('invalid_request');
  });
});
