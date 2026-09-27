import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { openProductionConnector } from './production';

describe('installed hosted connector composition', () => {
  it('pins one durable proof key to the same provider-named native session across restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-hosted-production-'));
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team',
      browserBundleDirectory: path.join(directory, 'substrate-browser'),
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, openBrowser: async () => undefined,
      openInbox: async () => undefined };
    try {
      const first = await openProductionConnector(input);
      const key = first.ports.pairing?.jkt;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(await first.status()).toMatchObject({ connected: false, binding: null });
      await first.close();
      const restarted = await openProductionConnector(input);
      expect(restarted.ports.pairing?.jkt).toBe(key);
      await restarted.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses an origin that could redirect consent or DPoP authority', async () => {
    await expect(openProductionConnector({ stateDirectory: '/tmp/khala-invalid',
      appOrigin: 'https://khala.aiur.team/path', browserBundleDirectory: '/tmp/bundle',
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, openBrowser: async () => undefined,
      openInbox: async () => undefined,
    })).rejects.toThrow('production_origin_invalid');
  });

  it('refuses a relative browser executable supplied by the installed launcher', async () => {
    await expect(openProductionConnector({ stateDirectory: '/tmp/khala-invalid',
      appOrigin: 'https://khala.aiur.team', browserBundleDirectory: '/tmp/bundle',
      chromiumExecutablePath: '../browser/chrome',
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, openBrowser: async () => undefined,
      openInbox: async () => undefined,
    })).rejects.toThrow('production_path_invalid');
  });
});
