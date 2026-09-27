import { describe, expect, it, vi } from 'vitest';
import { installedHostedSession } from './hosted-main.js';
import type { OpenProductionConnector } from './hosted-production.js';

describe('installed hosted CLI composition', () => {
  it('uses isolated durable state, packaged browser assets, and the provider-named session', async () => {
    const openConnector = vi.fn<OpenProductionConnector>(async () => ({
      ports: {} as never,
      async send(input) { return { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
      async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      async listChannels() { return { kind: 'unavailable' }; },
      async listAgents() { return { kind: 'unavailable' }; },
      async inbox() { throw new Error('no binding'); },
      async close() {},
    }));
    const factory = installedHostedSession({
      openConnector, environment: { HOME: '/tmp/home', PATH: '', KHALA_APP_ORIGIN: 'https://preview.example' },
      stateDirectory: '/tmp/home/.local/state/khala', distDirectory: '/tmp/package/dist', workdir: '/tmp/project',
      async openInbox() { throw new Error('no binding'); },
    });
    await (await factory({ harness: 'codex', sessionId: 'thread-1' })).close();
    const input = openConnector.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      stateDirectory: '/tmp/home/.local/state/khala/hosted', appOrigin: 'https://preview.example',
      browserBundleDirectory: '/tmp/package/dist/substrate-browser',
      session: { harness: 'codex', sessionId: 'thread-1', workdir: '/tmp/project' },
    });
    expect(await input?.inspectHostedCodexHooks()).toBeNull();
  });

  it('refuses a non-HTTPS preview origin before opening the endpoint', () => {
    expect(() => installedHostedSession({
      openConnector: async () => { throw new Error('must stay closed'); },
      environment: { KHALA_APP_ORIGIN: 'http://preview.example' },
      stateDirectory: '/tmp/state', distDirectory: '/tmp/dist', workdir: '/tmp/project',
      async openInbox() { throw new Error('must stay closed'); },
    })).toThrow('invalid hosted origin');
  });
});
