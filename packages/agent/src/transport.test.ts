import { expect, it, vi } from 'vitest';
import { startChannelSession } from './transport';
const mocks = vi.hoisted(() => ({ matrix: vi.fn(async () => ({ userId: 'matrix' })), local: vi.fn() }));
vi.mock('./matrix/session', () => ({ createAgentMatrixSession: mocks.matrix }));
vi.mock('./local/session', () => ({ createLocalSession: mocks.local }));
const creds = { homeserver: 'https://matrix.example', userId: '@a:s', accessToken: 'secret', deviceId: 'd', roomId: '!r:s' };
it.each([undefined, 'matrix'] as const)('selects matrix for transport %s', async transport => {
  mocks.matrix.mockClear();
  const input = { ...creds, ...(transport ? { transport } : {}) };
  expect(await startChannelSession(input)).toEqual({ userId: 'matrix' });
  expect(mocks.matrix).toHaveBeenCalledExactlyOnceWith(input, undefined);
  expect(mocks.local).not.toHaveBeenCalled();
});

it('forwards authoritative removal checks to the hosted session', async () => {
  mocks.matrix.mockClear(); const checkRemoved = vi.fn(async () => true);
  await startChannelSession(creds, { checkRemoved });
  expect(mocks.matrix).toHaveBeenCalledExactlyOnceWith(creds, { checkRemoved });
});
