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
    dispose: vi.fn(),
  };
}

const identity = {
  current: vi.fn(),
  beginSignIn: vi.fn(),
  signOut: vi.fn(),
} as IdentityPort;

const renderRoom = vi.fn(() => <p>live room</p>);

describe('HumanApplicationScreen', () => {
  it('renders signed-out and unavailable states explicitly', () => {
    const signedOut = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })} identity={identity} routes={routes} renderRoom={renderRoom} />,
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
      />,
    );
    expect(unavailable).toContain('unavailable');
    expect(unavailable).not.toContain('Create a chat');
  });

  it('keeps standalone chrome out of a host-content mount', () => {
    const snapshot = { phase: 'signed_out', path: '/', context: null } as const;
    const hosted = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} mode="hosted-content" />,
    );
    expect(hosted).toContain('khala-content-root');
    expect(hosted).not.toContain('AIUR');

    const standalone = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} renderRoom={renderRoom} mode="standalone" />,
    );
    expect(standalone).toContain('AIUR');
  });

  it('delegates a ready room route to the required live room renderer', () => {
    const context = { path: '/channels/room_1' } as HumanRouteContext;
    const room = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({ phase: 'ready', path: context.path, context } as HumanApplicationSnapshot)}
        identity={identity}
        routes={routes}
        renderRoom={renderRoom}
        capabilities={[]}
      />,
    );
    expect(room).toContain('live room');
    expect(renderRoom).toHaveBeenCalledWith(context, { kind: 'channel', path: '/channels/room_1', roomId: 'room_1' });
  });
});
