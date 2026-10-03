// Captures the props the owner shells pass to the settings menu; a separate
// file because the module mock would break the markup assertions in `mount.test.tsx`.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityPort } from '@khala/contracts/messaging/index';
import type { SettingsMenuProps } from '../../ui/khala/SettingsMenu';
import { createHumanRouteCodec } from './routes';
import { HumanApplicationScreen, type HumanAccountMode } from './mount';
import type { HumanApplicationHandle, HumanApplicationSnapshot, HumanRouteContext } from './application';

const captured: SettingsMenuProps[] = [];
vi.mock('../../ui/khala/SettingsMenu', async original => ({
  ...(await original<typeof import('../../ui/khala/SettingsMenu')>()),
  SettingsMenu: (props: SettingsMenuProps) => { captured.push(props); return null; },
}));

const routes = createHumanRouteCodec({ origin: 'https://khala.aiur.team', basePath: '/' });
const identity = { current: vi.fn(), beginSignIn: vi.fn(), signOut: vi.fn() } as IdentityPort;

function render(snapshot: HumanApplicationSnapshot, account?: HumanAccountMode) {
  const application: HumanApplicationHandle = {
    getSnapshot: () => snapshot, subscribe: () => () => undefined, navigate: vi.fn(), retryDevice: vi.fn(), signOut: vi.fn(), dispose: vi.fn(),
  };
  renderToStaticMarkup(<HumanApplicationScreen application={application} identity={identity} routes={routes}
    renderRoom={() => null} {...(account ? { account } : {})} />);
}

const ready = (): HumanApplicationSnapshot => {
  const context = { path: '/conversations', principal: { ownerId: 'local-owner' } } as HumanRouteContext;
  return { phase: 'ready', path: context.path, context };
};

describe('settings menu account wiring', () => {
  beforeEach(() => { captured.length = 0; });

  it('passes no sign-out to the ready shell menu for the local owner', () => {
    render(ready(), 'local_owner');
    expect(captured.length).toBeGreaterThan(0);
    for (const props of captured) {
      expect(props.onSignOut).toBeUndefined();
      expect(props.signingOut).toBeUndefined();
      expect(props.onEditProfile).toBeTypeOf('function');
    }
  });

  it('keeps sign-out in the ready shell menu for OAuth', () => {
    render(ready());
    expect(captured.length).toBeGreaterThan(0);
    for (const props of captured) expect(props.onSignOut).toBeTypeOf('function');
  });

  it('passes no sign-out to the pending shell menu for the local owner', () => {
    render({ phase: 'unavailable', source: 'device', reason: 'device_unavailable', retryable: true, path: '/conversations', context: null }, 'local_owner');
    expect(captured.length).toBeGreaterThan(0);
    for (const props of captured) expect(props.onSignOut).toBeUndefined();
  });
});
