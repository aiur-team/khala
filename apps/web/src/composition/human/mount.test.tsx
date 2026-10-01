import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as inboxModule from '../../features/channel-access/ChannelRequestsInbox';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { createChannelAccessInboxController } from '../../features/channel-access/controller';
import { createFakeJournal } from '../../features/channel-access/fakes';
import { createHumanRouteCodec } from './routes';
import { HumanApplicationScreen } from './mount';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from './application';

// No DOM environment is available and static rendering skips effects, so the
// deep link is asserted at the seam: the props the real inbox receives.
vi.mock('../../features/channel-access/ChannelRequestsInbox', async importOriginal => {
  const actual = await importOriginal<typeof import('../../features/channel-access/ChannelRequestsInbox')>();
  return { ...actual, ChannelRequestsInbox: vi.fn(actual.ChannelRequestsInbox) };
});

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

async function channelAccessController(count = 1) {
  const journal = createFakeJournal();
  for (let index = 0; index < count; index += 1) {
    journal.submit({ kind: 'access', title: `Channel ${index}`, fingerprint: `agent-${index}` });
  }
  const controller = createChannelAccessInboxController({ requests: journal.port });
  controller.start();
  await vi.waitFor(() => expect(controller.getView().phase).toBe('ready'));
  return controller;
}

describe('HumanApplicationScreen', () => {
  it('renders signed-out and unavailable states explicitly', async () => {
    const channelAccess = await channelAccessController();
    const signedOut = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })} identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess} />,
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
        createChannelAccess={() => channelAccess}
      />,
    );
    expect(unavailable).toContain('unavailable');
    expect(unavailable).not.toContain('Create a chat');
  });

  it('keeps inactive and timed-out device states in the signed-in shell with retry', async () => {
    const channelAccess = await channelAccessController();
    for (const snapshot of [
      { phase: 'inactive', path: '/channels/room_1', context: null } as const,
      { phase: 'unavailable', source: 'device', reason: 'lease_unavailable', retryable: true,
        path: '/channels/room_1', context: null } as const,
    ]) {
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application(snapshot)} identity={identity}
        routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess} />);
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
    })} identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess} />);
    expect(storageFailure).not.toContain('other tab');
    expect(storageFailure).toContain('storage_unavailable');
  });

  it('explains personal links to a signed-out invitee without exposing the link reference', async () => {
    const channelAccess = await channelAccessController();
    const inviteRef = 'inv_opaqueSecret123';
    const html = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: `/join/${inviteRef}`, context: null })}
        identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess} />,
    );
    expect(html).toContain('Humans: sign in');
    expect(html).toContain('Joining as a person gives you your own link for your agent');
    expect(html).toContain('Agent requests still wait for your approval');
    expect(html).toContain('href="/AGENTS.md"');
    expect(html).not.toContain(inviteRef);
  });

  it('shows retained-key guidance for signed-in loss without offering room access or replacement', async () => {
    const channelAccess = await channelAccessController();
    for (const reason of ['storage_cleared', 'key_material_missing']) {
      renderRoom.mockClear();
      const html = renderToStaticMarkup(
        <HumanApplicationScreen
          application={application({ phase: 'unavailable', source: 'device', reason, retryable: true,
            path: '/channels/room_1', context: null })}
          identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess}
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
        renderRoom={renderRoom} createChannelAccess={() => channelAccess} />,
    );
    expect(revoked).not.toContain('original keys');
    expect(revoked).toContain('revoked_by_owner');
    expect(revoked).toContain('aria-label="Log out"');
  });

  it('shows a gated channel index during device initialization and recoverable failure', async () => {
    const createChannelAccess = vi.fn(() => { throw new Error('inbox must wait for device readiness'); });
    for (const snapshot of [
      { phase: 'initializing_device', path: '/new', context: null } as const,
      { phase: 'unavailable', source: 'device', reason: 'device_unavailable', retryable: true,
        path: '/new', context: null } as const,
    ]) {
      renderRoom.mockClear();
      const html = renderToStaticMarkup(<HumanApplicationScreen application={application(snapshot)} identity={identity}
        routes={routes} renderRoom={renderRoom} createChannelAccess={createChannelAccess} mode="standalone" />);
      expect(html).toContain('khala-owner-shell');
      expect(html).toContain('aria-label="Conversations"');
      expect(html).toContain('aria-label="Create channel" title="Create channel" disabled');
      expect(html).toContain('aria-label="Log out"');
      expect(html).not.toContain('Account and device status');
      expect(html).not.toContain('Create a channel');
      expect(renderRoom).not.toHaveBeenCalled();
    }
    expect(createChannelAccess).not.toHaveBeenCalled();
  });

  it('keeps identity checking in a neutral shell without owner actions', () => {
    const createChannelAccess = vi.fn();
    const html = renderToStaticMarkup(<HumanApplicationScreen application={application({
      phase: 'checking_identity', path: '/new', context: null,
    })} identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={createChannelAccess} />);
    expect(html).toContain('khala-owner-shell');
    expect(html).toContain('Checking your sign-in…');
    expect(html).not.toContain('Account and device status');
    expect(html).not.toContain('aria-label="Log out"');
    expect(createChannelAccess).not.toHaveBeenCalled();
  });

  it('keeps standalone chrome out of a host-content mount', async () => {
    const channelAccess = await channelAccessController();
    const snapshot = { phase: 'signed_out', path: '/', context: null } as const;
    const hosted = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess} mode="hosted-content" />,
    );
    expect(hosted).toContain('khala-content-root');
    expect(hosted).not.toContain('aiur-shell__topbar');

    const standalone = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess} mode="standalone" />,
    );
    expect(standalone).toContain('class="aiur-shell__brand" href="/new"');
  });

  it('delegates a ready room route to the required live room renderer', async () => {
    const channelAccess = await channelAccessController();
    const context = readyContext('/channels/room_1');
    const room = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        createChannelAccess={() => channelAccess}
        capabilities={[]}
      />,
    );
    expect(room).toContain('live room');
    expect(room).toContain('aria-label="Log out"');
    expect(room).toContain('<div class="khala-content-actions"><button');
    expect(room).toContain('id="khala-channel-toolbar"');
    expect(room.indexOf('aria-label="Toggle color theme"')).toBeLessThan(room.indexOf('aria-label="Log out"'));
    expect(renderRoom).toHaveBeenCalledWith(context, { kind: 'channel', path: '/channels/room_1', roomId: 'room_1' }, expect.any(Function), routes);
  });

  it('puts a standalone channel toolbar in the existing top navigation', async () => {
    const channelAccess = await channelAccessController();
    const context = readyContext('/channels/room_1');
    const html = renderToStaticMarkup(<HumanApplicationScreen
      application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
      identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess}
      capabilities={[]} mode="standalone" />);
    expect(html).not.toContain('id="khala-channel-toolbar-mobile"');
    expect(html).toContain('id="khala-channel-toolbar"');
    expect(html).not.toContain('class="khala-mobile-bar"');
    expect(html.indexOf('id="khala-channel-toolbar"')).toBeLessThan(html.indexOf('class="aiur-shell__content"'));
  });

  it('opens channel care as a separate route without adding a chat settings control', async () => {
    const channelAccess = await channelAccessController(0);
    const context = readyContext('/channels/room_1');
    const renderChannelTools = vi.fn(() => <p>Recovery and recipient review</p>);
    const props = { identity, routes, renderRoom, renderChannelTools, createChannelAccess: () => channelAccess, capabilities: [] };
    const room = renderToStaticMarkup(<HumanApplicationScreen {...props}
      application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)} />);
    expect(room).toContain('href="/channels/room_1/tools"');
    expect(room).toContain('aria-label="Channel care"');
    expect(room).toContain('title="Channel care"');
    expect(room).not.toContain('>Channel care</a>');
    expect(room).not.toContain('Channel settings');
    expect(room).not.toContain('Channel requests, 0 pending');
    const toolsContext = readyContext('/channels/room_1/tools');
    const tools = renderToStaticMarkup(<HumanApplicationScreen {...props}
      application={application({ phase: 'ready', path: toolsContext.path, context: toolsContext } as HumanApplicationSnapshot)} />);
    expect(tools).toContain('Recovery and recipient review');
    expect(tools).toContain('aria-current="page"');
    expect(renderChannelTools).toHaveBeenCalledWith(toolsContext,
      { kind: 'channel', path: '/channels/room_1', roomId: 'room_1' }, expect.any(Function), routes);
  });

  it('mounts the owner inbox route with a badge capped at 50', async () => {
    const channelAccess = await channelAccessController(60);
    const context = readyContext('/channel-requests');
    const html = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        createChannelAccess={() => channelAccess}
        capabilities={[]}
        mode="standalone"
      />,
    );

    expect(html).toContain('Channel requests');
    expect(html).toContain('aria-label="Log out"');
    expect(html).toContain('class="aiur-shell__brand" href="/conversations"');
    expect(html).toContain('href="/conversations"');
    expect(html).toContain('aria-label="Create channel"');
    expect(html).toContain('<strong>Conversations</strong>');
    expect(html).not.toContain('class="aiur-shell__nav-label">Khala</span>');
    expect(html).toContain('<h1 id="khala-channel-requests-title">Channel requests</h1>');
    expect(html).not.toContain('<h2>Channel requests</h2>');
    expect(html).toContain('<h2 id="channel-requests-pending-heading"');
    expect(html).toContain('<h2 id="channel-requests-recent-heading">Recent</h2>');
    expect(html).toContain('>50<');
    expect(html).toContain('50 pending');
    expect(html.indexOf('class="channel-requests-nav"')).toBeLessThan(html.indexOf('aria-label="Create channel"'));
    expect(html).toContain('Waiting for you (60)');
  });

  it('hides the request control for a ready inbox with no pending work', async () => {
    const channelAccess = await channelAccessController(0);
    const context = readyContext('/channels/room_1');
    const html = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'ready', path: context.path, context })}
        identity={identity} routes={routes} renderRoom={renderRoom} createChannelAccess={() => channelAccess}
        capabilities={[]} mode="standalone" />,
    );
    expect(html).not.toContain('class="channel-requests-nav"');
    expect(html).not.toContain('0 pending');
    expect(html).toContain('aria-label="Create channel"');
  });

  it('deep-links /channel-requests/<handle> to that request', async () => {
    const channelAccess = await channelAccessController(2);
    const handle = channelAccess.getView().requests[1]!.requestHandle;
    const context = readyContext(routes.channelRequestsPath(handle));
    const inbox = vi.mocked(inboxModule.ChannelRequestsInbox);
    inbox.mockClear();
    renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        createChannelAccess={() => channelAccess}
        capabilities={[]}
      />,
    );
    expect(inbox).toHaveBeenCalled();
    expect(inbox.mock.calls[0]![0]).toMatchObject({ controller: channelAccess, selectedHandle: handle });
  });

  it('does not mount the owner inbox for agent or discovery credential routes', async () => {
    const channelAccess = await channelAccessController();
    const createChannelAccess = vi.fn(() => channelAccess);
    for (const snapshot of [
      { phase: 'signed_out', path: '/channel-requests', context: null } as const,
      { phase: 'unavailable', source: 'identity', reason: 'forbidden', retryable: false, path: '/channel-requests', context: null } as const,
    ]) {
      const html = renderToStaticMarkup(
        <HumanApplicationScreen
          application={application(snapshot)}
          identity={identity}
          routes={routes}
          renderRoom={renderRoom}
          createChannelAccess={createChannelAccess}
          mode="standalone"
        />,
      );
      expect(html).not.toContain('Channel requests');
      expect(html).not.toContain('channel-requests');
    }
    expect(createChannelAccess).not.toHaveBeenCalled();
  });

  it('creates owner-scoped inbox controllers instead of reusing retained state', async () => {
    const alice = await channelAccessController(1);
    const bob = await channelAccessController(2);
    const createChannelAccess = vi.fn()
      .mockReturnValueOnce(alice)
      .mockReturnValueOnce(bob);

    for (const context of [readyContext('/channel-requests', 'owner_alice'), readyContext('/channel-requests', 'owner_bob')]) {
      renderToStaticMarkup(
        <HumanApplicationScreen
          application={application({ phase: 'ready', path: context.path, context })}
          identity={identity}
          routes={routes}
          renderRoom={renderRoom}
          createChannelAccess={createChannelAccess}
          capabilities={[]}
          mode="standalone"
        />,
      );
    }

    expect(createChannelAccess).toHaveBeenCalledTimes(2);
  });
});
