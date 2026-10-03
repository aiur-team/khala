import { expect, it } from 'vitest';
import type { LocalAuth, LocalResponse, LocalStore } from './types';

it('models all auth kinds, redirects and departed members', () => {
  const auth: LocalAuth[] = [{ kind: 'none' }, { kind: 'owner', via: 'cookie' }, { kind: 'owner', via: 'admin' }, { kind: 'agent', userId: '@agent-a1b2c3d4:local', roomId: '!AAAAAAAAAAAAAAAAAAAAAA:local' }];
  const redirect: LocalResponse = { status: 302, location: '/open/token' };
  const left: NonNullable<ReturnType<LocalStore['member']>> = {
    userId: '@agent-a1b2c3d4:local', participantId: '@agent-a1b2c3d4:local', ownerId: 'local-owner',
    deviceId: 'KH_LOCAL_a1b2c3d4', displayName: 'kevin-Codex', kind: 'agent', membership: 'leave',
  };
  expect(left.membership).toBe('leave');
  expect(auth.map(value => value.kind)).toEqual(['none', 'owner', 'owner', 'agent']);
  expect(redirect.status).toBe(302);
});
