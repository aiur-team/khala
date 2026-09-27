import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSetupService } from './plan.js';
import { createPrivateChromiumAssets, hasSystemChromium, type PinnedBrowserCatalog } from './private-chromium.js';
import { executeSetupPlan } from './transaction.js';
import type { SetupAdapter, SetupEnvironment } from './types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const sample = new Map([['chrome', Buffer.from('browser executable')], ['resources.pak', Buffer.from('browser data')]]);
const catalog: PinnedBrowserCatalog = {
  playwrightCore: '1.63.0', chromiumRevision: '1243', chromeVersion: '153.0.8010.12',
  files: [...sample].map(([name, bytes]) => ({ path: name, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), mode: name === 'chrome' ? 0o500 : 0o400 })),
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-private-browser-test-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const config = path.join(home, '.config');
  const data = path.join(home, '.local', 'share');
  const state = path.join(home, '.local', 'state');
  await fs.mkdir(home, { recursive: true });
  let systemVersion: string | null = null;
  const environment: SetupEnvironment = {
    home, xdgConfigHome: config, xdgDataHome: data, xdgStateHome: state,
    probe: {
      async resolveExecutable(name) { return name === 'codex' ? '/usr/bin/codex' : name === 'chromium' && systemVersion ? '/usr/bin/chromium' : null; },
      async runVersion(executable) { return executable === '/usr/bin/chromium' ? systemVersion ?? '' : 'codex-cli 0.154.0'; },
      async readFile(file) { try { return new Uint8Array(await fs.readFile(file)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      } },
      async listDirectory(directory) { try { return await fs.readdir(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      } },
    },
  };
  return { root, home, config, data, state, environment, systemBrowser(value: string | null) { systemVersion = value; } };
}

function stageFixture(wrong = false, visited: string[] = []) {
  return async (_driver: string, staging: string) => {
    visited.push(staging);
    const directory = path.join(staging, 'chromium-1243', 'chrome-linux64');
    await fs.mkdir(directory, { recursive: true });
    for (const [name, bytes] of sample) await fs.writeFile(path.join(directory, name),
      wrong && name === 'chrome' ? Buffer.alloc(bytes.length, 0x78) : bytes);
  };
}

const adapter: SetupAdapter = {
  harness: 'codex',
  detect: async () => ({ executable: '/usr/bin/codex', version: '0.154.0', supported: true }),
  inspect: async (_env, detection) => ({ detection, components: [], route: 'unknown', diagnostics: [] }),
  plan: () => [],
};

it('plans without acquisition, then installs and removes the exact private files under the real manifest transaction', async () => {
  const place = await fixture();
  const stages: string[] = [];
  const browser = createPrivateChromiumAssets({ version: '0.1.0', driverDirectory: '/unused',
    stage: stageFixture(false, stages), catalog });
  const service = createSetupService({ environment: () => place.environment, adapters: [adapter],
    payload: browser.files, prepareConfirmed: browser.prepareConfirmed,
    execute: request => executeSetupPlan({ roots: { home: place.home, xdgConfigHome: place.config,
      xdgDataHome: place.data, xdgStateHome: place.state }, searchPath: '/usr/bin',
      confirmedDigest: request.confirmedDigest, replan: () => request.replan() }),
  });
  const planned = await service.lifecycle('setup', { dryRun: true, confirm: null });
  expect(stages).toEqual([]);
  expect(planned.state).toBe('confirmation_required');
  expect(planned.confirmation).toMatchObject({ request: expect.stringContaining('downloads pinned Chromium') });
  const installed = await service.lifecycle('setup', { dryRun: false, confirm: planned.planDigest });
  expect(installed.state).toBe('configured_effect_unknown');
  expect(stages).toHaveLength(1);
  await expect(fs.stat(stages[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  const browserRoot = path.join(place.data, 'khala', 'versions', '0.1.0', 'chromium', 'chrome-linux64');
  expect(await fs.readFile(path.join(browserRoot, 'chrome'))).toEqual(sample.get('chrome'));
  expect((await fs.stat(path.join(browserRoot, 'chrome'))).mode & 0o777).toBe(0o500);
  const removal = await service.lifecycle('remove', { dryRun: true, confirm: null });
  expect(removal.state).toBe('confirmation_required');
  await service.lifecycle('remove', { dryRun: false, confirm: removal.planDigest });
  await expect(fs.stat(path.join(browserRoot, 'chrome'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an offline or mismatched acquisition before target writes and cleans temporary staging', async () => {
  const place = await fixture();
  const staged: string[] = [];
  for (const stage of [async (_driver: string, temporary: string) => { staged.push(temporary); throw new Error('offline'); },
    stageFixture(true, staged)]) {
    const browser = createPrivateChromiumAssets({ version: '0.1.0', driverDirectory: '/unused', stage, catalog });
    const service = createSetupService({ environment: () => place.environment, adapters: [adapter],
      payload: browser.files, prepareConfirmed: browser.prepareConfirmed,
      execute: async () => { throw new Error('must not execute'); },
    });
    const planned = await service.lifecycle('setup', { dryRun: true, confirm: null });
    const refused = await service.lifecycle('setup', { dryRun: false, confirm: planned.planDigest });
    expect(refused.state).toBe('unsupported');
    expect(refused.diagnostics.map(item => item.code)).toContain('asset_unavailable');
  }
  for (const staging of staged) await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(place.data, 'khala'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rolls back browser targets when the manifest transaction fails after its first write', async () => {
  const place = await fixture();
  const browser = createPrivateChromiumAssets({ version: '0.1.0', driverDirectory: '/unused',
    stage: stageFixture(), catalog });
  const service = createSetupService({ environment: () => place.environment, adapters: [adapter],
    payload: browser.files, prepareConfirmed: browser.prepareConfirmed,
    execute: request => executeSetupPlan({ roots: { home: place.home, xdgConfigHome: place.config,
      xdgDataHome: place.data, xdgStateHome: place.state }, searchPath: '/usr/bin',
      confirmedDigest: request.confirmedDigest, replan: () => request.replan(),
      boundary: name => { if (name === 'applied:0') throw new Error('injected boundary failure'); },
    }),
  });
  const planned = await service.lifecycle('setup', { dryRun: true, confirm: null });
  const failed = await service.lifecycle('setup', { dryRun: false, confirm: planned.planDigest });
  expect(failed.state).toBe('conflict');
  const browserRoot = path.join(place.data, 'khala', 'versions', '0.1.0', 'chromium', 'chrome-linux64');
  for (const name of sample.keys()) await expect(fs.stat(path.join(browserRoot, name))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(place.state, 'khala', 'setup', 'manifest.v1.json')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('skips acquisition when an installed Chromium probe succeeds', async () => {
  const place = await fixture();
  place.systemBrowser('Chromium 153.0.8010.12');
  expect(await hasSystemChromium(place.environment)).toBe(true);
  for (const unsupported of ['Chromium 149.0.0.0', 'Google Chrome 154.0.0.0', 'not a browser']) {
    place.systemBrowser(unsupported);
    expect(await hasSystemChromium(place.environment)).toBe(false);
  }
  place.systemBrowser('Chromium 153.0.8010.12');
  const browser = createPrivateChromiumAssets({ version: '0.1.0', driverDirectory: '/unused',
    stage: async () => { throw new Error('must not stage'); }, catalog });
  expect(await browser.files(place.environment)).toEqual([]);
  await browser.prepareConfirmed('setup', place.environment);
});
