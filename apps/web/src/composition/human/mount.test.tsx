import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import { createHumanRouteCodec } from './routes';
import { HumanApplicationScreen } from './mount';
import type { HumanApplicationHandle, HumanApplicationSnapshot } from './application';

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

describe('HumanApplicationScreen', () => {
  it('renders signed-out and unavailable states explicitly', () => {
    const signedOut = renderToStaticMarkup(
      <HumanApplicationScreen application={application({ phase: 'signed_out', path: '/', context: null })} identity={identity} routes={routes} />,
    );
    expect(signedOut).toContain('Sign in');

    const unavailable = renderToStaticMarkup(
      <HumanApplicationScreen
        application={application({
          phase: 'unavailable', source: 'identity', reason: 'identity_unavailable', retryable: true, path: '/', context: null,
        })}
        identity={identity}
        routes={routes}
      />,
    );
    expect(unavailable).toContain('unavailable');
    expect(unavailable).not.toContain('Create a chat');
  });

  it('keeps standalone chrome out of a host-content mount', () => {
    const snapshot = { phase: 'signed_out', path: '/', context: null } as const;
    const hosted = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} mode="hosted-content" />,
    );
    expect(hosted).toContain('khala-content-root');
    expect(hosted).not.toContain('AIUR');

    const standalone = renderToStaticMarkup(
      <HumanApplicationScreen application={application(snapshot)} identity={identity} routes={routes} mode="standalone" />,
    );
    expect(standalone).toContain('AIUR');
  });
});
