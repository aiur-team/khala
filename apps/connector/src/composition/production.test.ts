import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { hasProductionBinding, openProductionConnector, subscriptionDiagnostic, supportedBrowserVersion } from './production';

describe('installed hosted connector composition', () => {
  it('checks only an exact admitted session marker without creating hosted state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-hosted-presence-'));
    const first = { harness: 'codex', sessionId: 'thread-1', workdir: '/project' };
    const other = { ...first, sessionId: 'thread-2' };
    try {
      expect(await hasProductionBinding(directory, first)).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      const opened = await openProductionConnector({ stateDirectory: directory,
        appOrigin: 'https://khala.aiur.team', browserBundleDirectory: path.join(directory, 'substrate-browser'),
        session: first, sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
        inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
        openBrowser: async () => undefined, openInbox: async () => undefined });
      await opened.close();
      // A pending pair has state, but ordinary tools and hooks still need an admitted binding.
      expect(await hasProductionBinding(directory, first)).toBe(false);
      const [session] = await readdir(directory);
      const marker = path.join(directory, session!, 'current-binding.json');
      await writeFile(marker, '{}');
      expect(await hasProductionBinding(directory, first)).toBe(true);
      expect(await hasProductionBinding(directory, other)).toBe(false);
      await rm(marker);
      await mkdir(path.join(directory, 'target'));
      await symlink(path.join(directory, 'target'), marker);
      expect(await hasProductionBinding(directory, first)).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('distinguishes offline recovery, unsupported substrate, and unknown catch-up from live intake', () => {
    expect(subscriptionDiagnostic({ kind: 'offline', retryAt: null })).toEqual({
      prerequisite: 'offline', errorCode: 'subscription_offline',
    });
    expect(subscriptionDiagnostic({ kind: 'blocked', code: 'unsupported' })).toEqual({
      prerequisite: 'unsupported', errorCode: 'subscription_unsupported',
    });
    expect(subscriptionDiagnostic({ kind: 'blocked', code: 'missing_keys' })).toEqual({
      prerequisite: 'blocked', errorCode: 'subscription_missing_keys',
    });
    expect(subscriptionDiagnostic({ kind: 'catching_up', streamId: 'stream-1' })).toEqual({
      prerequisite: 'unknown', errorCode: 'subscription_starting',
    });
    expect(subscriptionDiagnostic({ kind: 'live', streamId: 'stream-1' })).toBeNull();
  });
  it('admits only the browser majors proven with the pinned driver', () => {
    expect(supportedBrowserVersion('Chromium 150.0.7871.128')).toBe(true);
    expect(supportedBrowserVersion('Google Chrome for Testing 153.0.8010.12')).toBe(true);
    expect(supportedBrowserVersion('Chromium 120.0.0.0')).toBe(false);
    expect(supportedBrowserVersion('Firefox 153.0')).toBe(false);
  });
  it('pins one durable proof key to the same provider-named native session across restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-hosted-production-'));
    const input = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team',
      browserBundleDirectory: path.join(directory, 'substrate-browser'),
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined,
      openInbox: async () => undefined };
    try {
      const first = await openProductionConnector(input);
      const key = first.ports.pairing?.jkt;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(await first.status()).toMatchObject({ connected: false, binding: null, readiness: {
        phase: 'degraded', errorCode: 'binding_not_established', prerequisites: {
          storage: 'ready', device: 'blocked', bootstrap: 'blocked',
          harness: 'unknown', dispatch: 'blocked', recovery: 'unknown',
        },
      } });
      await first.close();
      expect(await first.status()).toMatchObject({ connected: false, readiness: {
        phase: 'stopped', errorCode: 'connector_closed', prerequisites: { storage: 'offline' },
      } });
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
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined,
      openInbox: async () => undefined,
    })).rejects.toThrow('production_origin_invalid');
  });

  it('refuses a relative browser executable supplied by the installed launcher', async () => {
    await expect(openProductionConnector({ stateDirectory: '/tmp/khala-invalid',
      appOrigin: 'https://khala.aiur.team', browserBundleDirectory: '/tmp/bundle',
      chromiumExecutablePath: '../browser/chrome',
      session: { harness: 'codex', sessionId: 'thread-owned-1', workdir: '/project' },
      sessionInspection: () => ({ inspect: async () => ({ kind: 'missing' as const }) }),
      inspectHostedCodexHooks: async () => null, resolveCodexExecutable: async () => null,
      openBrowser: async () => undefined,
      openInbox: async () => undefined,
    })).rejects.toThrow('production_path_invalid');
  });
});
