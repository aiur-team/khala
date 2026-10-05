import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ChannelSession } from './transport';
import { startChannelSession } from './transport';
import { createKhalaAgentClient } from './client-impl';
vi.mock('./transport', async importOriginal => ({
  ...await importOriginal<typeof import('./transport')>(), startChannelSession: vi.fn(),
}));
it('starts the default transport with polled credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'khala-996-transport-'));
  const creds = { homeserver: 'http://127.0.0.1:47830', userId: '@a:local', accessToken: 'secret', deviceId: 'd', roomId: '!r:local', transport: 'local' as const };
  const session: ChannelSession = {
    userId: creds.userId, inviter: () => undefined, onListeningModeCommand: () => () => {},
    publishListeningMode: async () => {}, onMessage: () => () => {}, waitForInvite: async () => {},
    join: async () => {}, history: async () => ({ messages: [] }), send: async () => ({ eventId: '$sent' }),
    sendChannelEvent: async () => ({ eventId: '$event' }), roomName: () => 'refactor', displayName: () => undefined,
    stop: async () => {},
  };
  vi.mocked(startChannelSession).mockResolvedValueOnce(session);
  const client = createKhalaAgentClient({ harness: 'codex', sessionId: 'default', env: { XDG_STATE_HOME: root }, joinApi: {
    requestJoin: async () => ({ origin: 'http://127.0.0.1:47830', joinId: 'j', pollSecret: 'p', confirmUrl: 'http://127.0.0.1:47830/agent/confirm', expiresAt: '2099-01-01T00:00:00Z', autoConfirmed: true }),
    pollJoin: async () => creds, reportReady: async () => {},
  } });
  try {
    expect(await client.join('http://127.0.0.1:47830/join/abcdefgh', 'Codex')).toEqual({ state: 'connected', channelName: 'refactor' });
    expect(startChannelSession).toHaveBeenCalledExactlyOnceWith(creds, { checkRemoved: expect.any(Function) });
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
