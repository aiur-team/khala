import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { createHumanRouteCodec } from './routes';
import { HumanApplicationScreen, LogoutAction, redirectToSignIn } from './mount';
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
  it.each(['/conversations', '/channels/!r1%3Akhala.local', `/join/inv_opaqueSecret123`, '/agent/confirm?joinId=j1'])(
    'shows only the signing-in spinner for signed-out %s', path => {
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application({ phase: 'signed_out', path, context: null })}
        identity={identity} routes={routes} renderRoom={renderRoom} />);
      expect(html).toContain('<section class="kh-state" aria-label="Signing in"><div class="kh-state-c">'
        + '<span class="kh-spin" aria-hidden="true"></span><b>Signing in…</b></div></section>');
      expect(html).not.toContain('Sign in to Khala');
      expect(html).not.toMatch(/<button[^>]*>Sign in<\/button>/);
      expect(html).not.toContain('Humans: sign in');
      expect(html).not.toContain('href="/AGENTS.md"');
      expect(html).not.toContain('inv_opaqueSecret123');
      expect(html).not.toContain('Agent confirmation unavailable');
    });

  it.each(['/conversations', '/join/inv_1', '/agent/confirm?joinId=j1'])('redirects signed-out %s to sign-in for the same path', async path => {
    const beginSignIn = vi.fn(async (returnPath: string) => ({
      kind: 'ok' as const,
      value: { kind: 'navigate' as const, url: `https://khala.local/api/human/auth/login?return_to=${encodeURIComponent(returnPath)}` },
    }));
    const navigateExternal = vi.fn();
    expect(await redirectToSignIn({ ...identity, beginSignIn } as IdentityPort, path, navigateExternal)).toBe(true);
    expect(beginSignIn).toHaveBeenCalledTimes(1);
    expect(beginSignIn).toHaveBeenCalledWith(path);
    expect(navigateExternal).toHaveBeenCalledTimes(1);
    expect(navigateExternal).toHaveBeenCalledWith(`https://khala.local/api/human/auth/login?return_to=${encodeURIComponent(path)}`);
  });

  it('reports sign-in that cannot start without navigating', async () => {
    const navigateExternal = vi.fn();
    const rejected = vi.fn(async () => ({ kind: 'rejected' as const, code: 'invalid_return_path' as const }));
    const throwing = vi.fn(async () => { throw new Error('offline'); });
    expect(await redirectToSignIn({ ...identity, beginSignIn: rejected } as IdentityPort, '/conversations', navigateExternal)).toBe(false);
    expect(await redirectToSignIn({ ...identity, beginSignIn: throwing } as IdentityPort, '/conversations', navigateExternal)).toBe(false);
    expect(navigateExternal).not.toHaveBeenCalled();
  });

  it('renders signed-out and unavailable states explicitly', async () => {
    const signedOut = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })} identity={identity} routes={routes} renderRoom={renderRoom} />,
    );
    expect(signedOut).toContain('Signing in…');
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
      expect(html).toContain('aria-label="Settings"');
      expect(html).not.toContain('live room');
    }
    const storageFailure = renderToStaticMarkup(<HumanApplicationScreen application={application({
      phase: 'unavailable', source: 'device', reason: 'storage_unavailable', retryable: true,
      path: '/channels/room_1', context: null,
    })} identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(storageFailure).not.toContain('other tab');
    expect(storageFailure).toContain('storage_unavailable');
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
      expect(html).toContain('aria-label="Settings"');
      expect(renderRoom).not.toHaveBeenCalled();
    }
    const revoked = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'unavailable', source: 'device', reason: 'revoked_by_owner',
        retryable: false, path: '/channels/room_1', context: null })} identity={identity} routes={routes}
        renderRoom={renderRoom} />,
    );
    expect(revoked).not.toContain('original keys');
    expect(revoked).toContain('revoked_by_owner');
    expect(revoked).toContain('aria-label="Settings"');
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
      expect(html).toContain('aria-label="Channels"');
      expect(html).toContain('aria-label="New channel" disabled');
      expect(html).toContain('aria-label="Settings"');
      expect(html).not.toContain('Account and device status');
      expect(html).not.toContain('kh-pop-h');
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
    expect(html).not.toContain('Logging out…');
    // The theme stays switchable from the cog; its menu has only Mode in this phase.
    expect(html).toContain('aria-label="Settings"');
  });

  it.each(['hosted-content', 'standalone'] as const)('renders signed-out %s inside the Khala frame with no topbar', mode => {
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })}
      identity={identity} routes={routes} renderRoom={renderRoom} mode={mode} />);
    expect(html).toMatch(/<div class="khala-app" data-theme="dark"><section class="section-card kh-card kh-solo" id="kh-card">/u);
    expect(html).toContain('<a class="wm" href="/new" aria-label="Khala home">khala</a>');
    expect(html).toContain('<div class="kh-state">');
    expect(html).not.toContain('aiur-shell__topbar');
    expect(html).not.toContain('aria-label="Log out"');
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
    expect(room).toContain('aria-label="New channel"');
    const brand = room.slice(room.indexOf('<div class="kh-brand">'), room.indexOf('</span></div>', room.indexOf('<span class="kh-brand-actions">')));
    expect(brand.match(/aria-label="Settings"/gu)).toHaveLength(1);
    expect(brand).toMatch(/<span class="kh-brand-actions"><button type="button" class="tool-btn icon-only" aria-label="Settings"[^>]*>(<svg.*?<\/svg>)<\/button>$/u);
    expect(room).not.toContain('aria-label="Log out"');
    expect(room).not.toContain('aria-label="Toggle color theme"');
    expect(renderRoom).toHaveBeenCalledWith(context, { kind: 'channel', path: '/channels/room_1', roomId: 'room_1' }, expect.any(Function), routes);
  });

  it.each(['hosted-content', 'standalone'] as const)('renders the %s owner shell edge to edge with no drawer or toolbar portal', mode => {
    const context = readyContext('/channels/room_1');
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} mode={mode} />);
    expect(html).toMatch(/<div class="khala-app khala-owner-shell" data-theme="dark"><section class="section-card kh-card in-thread" id="kh-card">/u);
    expect(html).toContain('<a class="wm" href="/conversations" aria-label="Khala home">khala</a>');
    expect(html).not.toContain('khala-channel-toolbar');
    expect(html).not.toContain('khala-mobile-bar');
    expect(html).not.toContain('khala-sidebar');
    expect(html).not.toContain('aiur-shell__topbar');
    // The list pane is the only "Channels" landmark; the retired sidebar nav used the same label.
    expect(html.split('aria-label="Channels"').length - 1).toBe(1);
  });

  it('keeps main content reachable on narrow screens for a join', () => {
    const context = readyContext('/join/inv_1');
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path: context.path, context })}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('class="section-card kh-card in-thread" id="kh-card"');
  });

  it('shows only a centred spinner while navigating to a channel', () => {
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'navigating', path: '/channels/room_2', context: readyContext('/channels/room_1') })}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('<div class="kh-loading" role="status" aria-label="Loading channel">'
      + '<span class="kh-spin" aria-hidden="true"></span><span class="sr-only">Loading channel</span></div>');
    expect(html).not.toContain('khala-route-loading');
  });

  it.each([
    { phase: 'ready', path: '/agent/confirm?joinId=j1', context: readyContext('/agent/confirm?joinId=j1') },
    { phase: 'navigating', path: '/agent/confirm?joinId=j1', context: readyContext('/channels/room_1') },
    { phase: 'initializing_device', path: '/agent/confirm?joinId=j1', context: null },
    { phase: 'inactive', path: '/agent/confirm?joinId=j1', context: null },
  ] as HumanApplicationSnapshot[])('renders the agent confirm page standalone while $phase', snapshot => {
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application(snapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toMatch(/^(<link [^>]*>)*<div class="khala-app kh-agent-confirm" data-theme="dark">/u);
    expect(html).toContain('<section class="kh-fin kh-fin--page" aria-label="Confirm agent">');
    expect(html).not.toContain('kh-card');
    expect(html).not.toContain('aria-label="Channels"');
  });

  it('derives the list view from the conversations route', () => {
    const context = readyContext('/conversations');
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('class="section-card kh-card" id="kh-card"');
    expect(html).not.toContain('aria-label="All channels"');
  });

  it('never shows a Live badge in the brand, even while the homeserver sync is live', () => {
    const syncStatus = { live: vi.fn(() => true), subscribe: vi.fn(() => () => undefined) };
    const context = { ...readyContext('/conversations'), generation: 3, syncStatus };
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).not.toContain('brand-live');
    expect(html).not.toContain('Live');
  });

  it('keeps a plain Log out button for signed-in failure screens outside the owner shell', () => {
    const html = renderToStaticMarkup(<LogoutAction application={application({ phase: 'checking_identity', path: '/', context: null })}
      routes={routes} mode="standalone" />);
    expect(html).toContain('<button type="button" class="tool-btn icon-only" aria-label="Log out" title="Log out">');
    expect(html).not.toContain('aria-label="Settings"');
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

describe('local owner account', () => {
  const panel = '<div class="kh-state"><div class="kh-state-c" role="alert"><b>Not connected</b><div class="kh-oneliner">'
    + '<code>khala local open</code><button type="button" class="kh-ib sm" data-tip="Copy" aria-label="Copy command"><svg';
  const identityUnavailable = {
    phase: 'unavailable', source: 'identity', reason: 'identity_unavailable', retryable: true, path: '/conversations', context: null,
  } as const;

  it.each(['/conversations', '/channels/room_1'])('offers no Log out in the ready shell on %s', path => {
    const context = readyContext(path);
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path, context } as HumanApplicationSnapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} account="local_owner" />);
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('aria-label="New channel"');
    expect(html).not.toContain('Log out');
    expect(html).not.toContain('Logging out');
  });

  it('shows the Not connected panel for a signed-out snapshot and never starts sign-in', () => {
    const beginSignIn = vi.fn();
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'signed_out', path: '/conversations', context: null })}
      identity={{ ...identity, beginSignIn } as IdentityPort} routes={routes} renderRoom={renderRoom} account="local_owner" />);
    expect(html).toContain(panel);
    expect(html).not.toContain('Signing in…');
    expect(html).not.toContain('Sign-in is unavailable');
    expect(html).not.toContain('Log out');
    expect(beginSignIn).not.toHaveBeenCalled();
  });

  it('shows the same panel when the identity is unavailable', () => {
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application(identityUnavailable)}
      identity={identity} routes={routes} renderRoom={renderRoom} account="local_owner" />);
    expect(html).toContain(panel);
    expect(html).not.toContain('Account and device status');
    expect(html).not.toContain('identity_unavailable');
    expect(html).not.toContain('Log out');
  });

  it('keeps pending device states in the owner shell without Log out', () => {
    for (const snapshot of [
      { phase: 'initializing_device', path: '/conversations', context: null } as const,
      { phase: 'unavailable', source: 'device', reason: 'device_unavailable', retryable: true, path: '/conversations', context: null } as const,
    ]) {
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application(snapshot)}
        identity={identity} routes={routes} renderRoom={renderRoom} account="local_owner" />);
      expect(html).toContain('khala-owner-shell');
      expect(html).toContain('aria-label="Settings"');
      expect(html).not.toContain('Log out');
    }
  });

  it('leaves the OAuth identity-unavailable frame untouched', () => {
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application(identityUnavailable)}
      identity={identity} routes={routes} renderRoom={renderRoom} />);
    expect(html).toContain('Account and device status');
    expect(html).not.toContain('Not connected');
  });
});
