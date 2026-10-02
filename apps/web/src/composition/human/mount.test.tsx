import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { createHumanRouteCodec } from './routes';
import { HumanApplicationScreen } from './mount';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from './application';

const routes = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });

function application(snapshot: HumanApplicationSnapshot): HumanApplicationHandle {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    navigate: vi.fn(),
    retryDevice: vi.fn(),
    signOut: vi.fn(),
    dispose: vi.fn(),
  };
}

const identity = {
  current: vi.fn(),
  beginSignIn: vi.fn(),
  signOut: vi.fn(),
} as IdentityPort;

const renderRoom = vi.fn(() => <p>live room</p>);

function readyContext(path: string, ownerId = 'owner_alice'): HumanRouteContext {
  return { path, principal: { ownerId } } as HumanRouteContext;
}

describe('HumanApplicationScreen', () => {
  it.each([
    ['?sign_in=cancelled&state=secret-state', 'Sign-in was cancelled. Choose Sign in to try again.'],
    ['?sign_in=error&error_description=secret-description', 'Sign-in could not be completed. Choose Sign in to try again.'],
  ])('shows a fixed retry message for %s without reflecting query details', (search, message) => {
    vi.stubGlobal('window', { location: { search } });
    try {
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })}
        identity={identity} routes={routes} renderRoom={renderRoom} />);
      expect(html).toContain(message);
      expect(html).not.toMatch(/secret-state|secret-description/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders signed-out and unavailable states explicitly', async () => {
    const signedOut = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })} identity={identity} routes={routes} renderRoom={renderRoom} />,
    );
    expect(signedOut).toContain('Sign in');
    expect(signedOut).not.toContain('aria-label="Log out"');
    expect(signedOut).not.toContain('class="aiur-shell__nav-label">Khala</span>');

    const unavailable = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({
          phase: 'unavailable', source: 'identity', reason: 'identity_unavailable', retryable: true, path: '/', context: null,
        })}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
      />,
    );
    expect(unavailable).toContain('unavailable');
    expect(unavailable).not.toContain('Create a chat');
  });

  it('keeps inactive and timed-out device states in the signed-in shell with retry', async () => {
    for (const snapshot of [
      { phase: 'inactive', path: '/channels/room_1', context: null } as const,
      { phase: 'unavailable', source: 'device', reason: 'lease_unavailable', retryable: true,
        path: '/channels/room_1', context: null } as const,
    ]) {
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application(snapshot)} identity={identity}
        routes={routes} renderRoom={renderRoom} />);
      expect(html).toContain('khala-owner-shell');
      if (snapshot.phase === 'inactive') expect(html).toContain('Channels are paused in this tab.');
      expect(html).toContain('Try again in this tab');
      expect(html).not.toContain('Account and device status');
      expect(html).toContain('aria-label="Log out"');
      expect(html).not.toContain('live room');
    }
    const storageFailure = renderToStaticMarkup(<HumanApplicationScreen application={application({
      phase: 'unavailable', source: 'device', reason: 'storage_unavailable', retryable: true,
      path: '/channels/room_1', context: null,
    })} identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(storageFailure).not.toContain('other tab');
    expect(storageFailure).toContain('storage_unavailable');
  });

  it('explains personal links to a signed-out invitee without exposing the link reference', async () => {
    const inviteRef = 'inv_opaqueSecret123';
    const html = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: `/join/${inviteRef}`, context: null })}
        identity={identity} routes={routes} renderRoom={renderRoom} />,
    );
    expect(html).toContain('Humans: sign in');
    expect(html).toContain('Joining as a person gives you your own link for your agent');
    expect(html).not.toContain('Agent requests still wait for your approval');
    expect(html).toContain('href="/AGENTS.md"');
    expect(html).not.toContain(inviteRef);
  });

  it('shows retained-key guidance for signed-in loss without offering room access or replacement', async () => {
    for (const reason of ['storage_cleared', 'key_material_missing', 'recovery_required']) {
      renderRoom.mockClear();
      const html = renderToStaticMarkup(
        <HumanApplicationScreen
          application={application({ phase: 'unavailable', source: 'device', reason, retryable: true,
            path: '/channels/room_1', context: null })}
          identity={identity} routes={routes} renderRoom={renderRoom}
        />,
      );
      expect(html).toContain('>Device keys unavailable</h2>');
      expect(html).toContain('khala-owner-shell');
      expect(html).not.toContain('Account and device status');
      expect(html).toContain('earlier history cannot be recovered');
      expect(html).toContain('fresh authorized admission');
      expect(html).toContain('open Khala there');
      expect(html).not.toContain('Check retained keys again');
      expect(html).not.toContain('Use new device');
      expect(html).not.toContain('live room');
      expect(html).toContain('aria-label="Log out"');
      expect(renderRoom).not.toHaveBeenCalled();
    }
    const revoked = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'unavailable', source: 'device', reason: 'revoked_by_owner',
        retryable: false, path: '/channels/room_1', context: null })} identity={identity} routes={routes}
        renderRoom={renderRoom} />,
    );
    expect(revoked).not.toContain('original keys');
    expect(revoked).toContain('revoked_by_owner');
    expect(revoked).toContain('aria-label="Log out"');
  });

  it('shows a gated channel index during device initialization and recoverable failure', async () => {
    for (const snapshot of [
      { phase: 'initializing_device', path: '/new', context: null } as const,
      { phase: 'unavailable', source: 'device', reason: 'device_unavailable', retryable: true,
        path: '/new', context: null } as const,
    ]) {
      renderRoom.mockClear();
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application(snapshot)} identity={identity}
        routes={routes} renderRoom={renderRoom} mode="standalone" />);
      expect(html).toContain('khala-owner-shell');
      expect(html).toContain('aria-label="Conversations"');
      expect(html).toContain('aria-label="Create channel" title="Create channel" disabled');
      expect(html).toContain('aria-label="Log out"');
      expect(html).not.toContain('Account and device status');
      expect(html).not.toContain('Create a channel');
      expect(renderRoom).not.toHaveBeenCalled();
    }
  });

  it('keeps identity checking in a neutral shell without owner actions', () => {
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application({
      phase: 'checking_identity', path: '/new', context: null,
    })} identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('khala-owner-shell');
    expect(html).toContain('Checking your sign-in…');
    expect(html).not.toContain('Account and device status');
    expect(html).not.toContain('aria-label="Log out"');
  });

  it('keeps standalone chrome out of a host-content mount', async () => {
    const snapshot = { phase: 'signed_out', path: '/', context: null } as const;
    const hosted = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} mode="hosted-content" />,
    );
    expect(hosted).toContain('khala-content-root');
    expect(hosted).not.toContain('aiur-shell__topbar');

    const standalone = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} mode="standalone" />,
    );
    expect(standalone).toContain('class="aiur-shell__brand" href="/new"');
  });

  it('delegates a ready room route to the required live room renderer', async () => {
    const context = readyContext('/channels/room_1');
    const room = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
      />,
    );
    expect(room).toContain('live room');
    expect(room).not.toContain('channel-requests');
    expect(room).toContain('aria-label="Create channel"');
    expect(room).toContain('aria-label="Log out"');
    expect(room).toContain('<div class="khala-content-actions"><button');
    expect(room).toContain('id="khala-channel-toolbar"');
    expect(room.indexOf('aria-label="Toggle color theme"')).toBeLessThan(room.indexOf('aria-label="Log out"'));
    expect(renderRoom).toHaveBeenCalledWith(context, { kind: 'channel', path: '/channels/room_1', roomId: 'room_1' }, expect.any(Function), routes);
  });

  it('puts a standalone channel toolbar in the existing top navigation', async () => {
    const context = readyContext('/channels/room_1');
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} mode="standalone" />);
    expect(html).not.toContain('id="khala-channel-toolbar-mobile"');
    expect(html).toContain('id="khala-channel-toolbar"');
    expect(html).not.toContain('class="khala-mobile-bar"');
    expect(html.indexOf('id="khala-channel-toolbar"')).toBeLessThan(html.indexOf('class="aiur-shell__content"'));
  });

  it.each(['/channels/room_1/tools', '/channel-requests', '/channel-requests/request_1'])('rejects the removed owner route %s', path => {
    renderRoom.mockClear();
    const context = readyContext(path);
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path, context })}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('Page not found');
    expect(html).not.toContain('Channel requests');
    expect(renderRoom).not.toHaveBeenCalled();
  });
});


describe('agent confirmation mount', () => {
  it('shows existing sign-in for a signed-out confirmation visitor', () => {
    const path = '/agent/confirm?joinId=j1';
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application({ phase: 'signed_out', path, context: null })}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Agent confirmation unavailable');
  });
  it('requires both confirmation capabilities', () => {
    const path = '/agent/confirm?joinId=j1';
    const context = readyContext(path);
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application({ phase: 'ready', path, context })}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('Agent confirmation unavailable');
  });
  it('mounts the confirmation screen when both ports are supplied', () => {
    const path = '/agent/confirm?joinId=j1';
    const context = { ...readyContext(path), agentJoin: { view: vi.fn(), confirm: vi.fn(), status: vi.fn() }, inviteAgent: vi.fn() };
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application({ phase: 'ready', path, context })}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('Confirm agent');
    expect(html).toContain('Loading agent request');
    expect(context.agentJoin.view).not.toHaveBeenCalled();
  });
});
