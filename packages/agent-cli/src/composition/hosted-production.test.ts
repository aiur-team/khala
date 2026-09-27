import { describe, expect, it, vi } from 'vitest';
import { hostedAppOrigin, hostedSessionFactory } from './hosted-production.js';
import type { OpenProductionConnector } from './hosted-production.js';

const SESSION = { harness: 'codex', sessionId: '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856' };

describe('installed hosted connector factory', () => {
  it('accepts only an exact configured HTTPS origin', () => {
    expect(hostedAppOrigin(undefined)).toBe('https://khala.aiur.team');
    expect(hostedAppOrigin('https://preview.example')).toBe('https://preview.example');
    for (const invalid of ['http://preview.example', 'https://preview.example/path', 'https://preview.example/',
      'https://user@preview.example', 'https://preview.example?x=1', 'not a URL']) {
      expect(() => hostedAppOrigin(invalid)).toThrow('invalid hosted origin');
    }
  });

  it('passes the provider session, native inspection, and endpoint-owned generation into one connector', async () => {
    const close = vi.fn(async () => undefined);
    const openConnector = vi.fn<OpenProductionConnector>(async () => ({
      ports: {} as never,
      async send(input) { return { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId }; },
      async status() { return { v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null }; },
      async listChannels() { return { kind: 'unavailable' }; },
      async listAgents() { return { kind: 'unavailable' }; },
      async inbox() { throw new Error('no binding'); },
      close,
    }));
    const factory = hostedSessionFactory({ openConnector,
      stateDirectory: '/tmp/khala-state/hosted', appOrigin: 'https://khala.aiur.team',
      browserBundleDirectory: '/tmp/package/dist/substrate-browser', workdir: '/tmp/project',
      readVersion: async () => '0.154.0', inspectHooks: async () => null,
      async openBrowser() {}, async openInbox() { throw new Error('no binding'); },
    });
    const opened = await factory(SESSION);
    const input = openConnector.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      session: { ...SESSION, workdir: '/tmp/project' },
      stateDirectory: '/tmp/khala-state/hosted',
      browserBundleDirectory: '/tmp/package/dist/substrate-browser',
    });
    const generationFor = vi.fn(async () => 4);
    const inspected = input?.sessionInspection(generationFor);
    expect(await inspected?.inspect({ ...SESSION, workdir: '/tmp/project' })).toMatchObject({
      kind: 'verified', session: { ...SESSION, generation: 4 },
    });
    expect(generationFor).toHaveBeenCalledExactlyOnceWith({ ...SESSION, workdir: '/tmp/project' });
    expect(await input?.inspectHostedCodexHooks()).toBeNull();
    expect((await opened.client.status()).connected).toBe(false);
    await opened.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
