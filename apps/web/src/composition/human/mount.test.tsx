import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { createChannelAccessInboxController } from '../../features/channel-access/controller';
import { createFakeJournal } from '../../features/channel-access/fakes';
import { createHumanRouteCodec } from './routes';
import { HumanApplicationScreen } from './mount';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from './application';

const routes = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });

function application(snapshot: HumanApplicationSnapshot): HumanApplicationHandle {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    navigate: vi.fn(),
    dispose: vi.fn(),
  };
}

const identity = {
  current: vi.fn(),
  beginSignIn: vi.fn(),
  signOut: vi.fn(),
} as IdentityPort;

const renderRoom = vi.fn(() => <p>live room</p>);

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
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })} identity={identity} routes={routes} renderRoom={renderRoom} channelAccess={channelAccess} />,
    );
    expect(signedOut).toContain('Sign in');

    const unavailable = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({
          phase: 'unavailable', source: 'identity', reason: 'identity_unavailable', retryable: true, path: '/', context: null,
        })}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        channelAccess={channelAccess}
      />,
    );
    expect(unavailable).toContain('unavailable');
    expect(unavailable).not.toContain('Create a chat');
  });

  it('keeps standalone chrome out of a host-content mount', async () => {
    const channelAccess = await channelAccessController();
    const snapshot = { phase: 'signed_out', path: '/', context: null } as const;
    const hosted = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} channelAccess={channelAccess} mode="hosted-content" />,
    );
    expect(hosted).toContain('khala-content-root');
    expect(hosted).not.toContain('AIUR');

    const standalone = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} channelAccess={channelAccess} mode="standalone" />,
    );
    expect(standalone).toContain('AIUR');
  });

  it('delegates a ready room route to the required live room renderer', async () => {
    const channelAccess = await channelAccessController();
    const context = { path: '/channels/room_1' } as HumanRouteContext;
    const room = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        channelAccess={channelAccess}
        capabilities={[]}
      />,
    );
    expect(room).toContain('live room');
    expect(renderRoom).toHaveBeenCalledWith(context, { kind: 'channel', path: '/channels/room_1', roomId: 'room_1' });
  });

  it('mounts the owner inbox route with a badge capped at 50', async () => {
    const channelAccess = await channelAccessController(60);
    const context = { path: '/channel-requests' } as HumanRouteContext;
    const html = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        channelAccess={channelAccess}
        capabilities={[]}
        mode="standalone"
      />,
    );

    expect(html).toContain('Channel requests');
    expect(html).toContain('>50<');
    expect(html).toContain('50 pending');
    expect(html).toContain('Waiting for you (60)');
  });

  it('does not mount the owner inbox for agent or discovery credential routes', async () => {
    const channelAccess = await channelAccessController();
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
          channelAccess={channelAccess}
          mode="standalone"
        />,
      );
      expect(html).not.toContain('Channel requests');
      expect(html).not.toContain('channel-requests');
    }
  });
});
