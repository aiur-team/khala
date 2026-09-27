import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import catalog from './chromium-1243.manifest.json' with { type: 'json' };
import type { InstallerFile } from './plan.js';
import type { SetupEnvironment, Sha256Digest } from './types.js';

/** Playwright-core 1.63.0's Linux x64 Chromium 1243, Chrome for Testing 153.0.8010.12. */
export const PRIVATE_CHROMIUM_BYTES = catalog.files.reduce((sum, file) => sum + file.bytes, 0);
const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'] as const;
type CatalogFile = Readonly<{ path: string; sha256: string; bytes: number; mode: number }>;
export type PinnedBrowserCatalog = Readonly<{
  playwrightCore: string; chromiumRevision: string; chromeVersion: string; files: readonly CatalogFile[];
}>;
type Stager = (driverDirectory: string, stagingDirectory: string) => Promise<void>;

function catalogPath(name: string): readonly string[] {
  const parts = name.split('/');
  if (parts.length === 0 || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')))
    throw new Error('invalid pinned browser path');
  return parts;
}

function digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A working, supported system browser is preferred to a private copy. */
export async function hasSystemChromium(environment: SetupEnvironment): Promise<boolean> {
  for (const name of BROWSER_NAMES) {
    const executable = await environment.probe.resolveExecutable(name);
    if (executable === null) continue;
    try {
      const version = await environment.probe.runVersion(executable, ['--version']);
      const match = /\b(?:Chromium|Google Chrome(?: for Testing)?) (\d+)\./u.exec(version);
      // The installed CDP route is proved on Chromium 150 and pinned Chrome 153 only.
      if (match && Number(match[1]) >= 150 && Number(match[1]) <= 153) return true;
    } catch { /* an unusable binary is not a supported browser */ }
  }
  return false;
}

/** This invocation writes only into its private temporary directory, never the global Playwright cache. */
export const stagePinnedChromium: Stager = async (driverDirectory, stagingDirectory) => {
  const manifest = JSON.parse(await fs.readFile(path.join(driverDirectory, 'package.json'), 'utf8')) as { version?: unknown };
  const browsers = JSON.parse(await fs.readFile(path.join(driverDirectory, 'browsers.json'), 'utf8')) as {
    browsers?: readonly { name?: string; revision?: string; browserVersion?: string }[];
  };
  const pinned = browsers.browsers?.find(browser => browser.name === 'chromium');
  if (manifest.version !== catalog.playwrightCore || pinned?.revision !== catalog.chromiumRevision
    || pinned.browserVersion !== catalog.chromeVersion) throw new Error('packaged browser installer changed');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(driverDirectory, 'cli.js'), 'install', 'chromium', '--no-shell'], {
      cwd: stagingDirectory, shell: false, stdio: 'ignore',
      env: { PLAYWRIGHT_BROWSERS_PATH: stagingDirectory, HOME: stagingDirectory, TMPDIR: stagingDirectory,
        PATH: process.env.PATH ?? '' },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('pinned browser acquisition failed'));
    });
  });
};

async function regularFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await visit(path.join(directory, item.name), relative);
      else if (item.isFile()) found.push(relative);
      else throw new Error('pinned browser contains a non-regular asset');
    }
  };
  await visit(root, '');
  return found.sort();
}

export function createPrivateChromiumAssets(input: Readonly<{
  version: string;
  driverDirectory: string;
  stage?: Stager;
  /** Allows a small pinned fixture to exercise the same transaction path in tests. */
  catalog?: PinnedBrowserCatalog;
}>) {
  const pinned = input.catalog ?? catalog;
  const expected = new Map<string, CatalogFile>(pinned.files.map(file => [file.path, file]));
  if (expected.size !== pinned.files.length || !expected.has('chrome')) throw new Error('invalid pinned browser catalog');
  for (const file of pinned.files) catalogPath(file.path);
  let hydrated: ReadonlyMap<string, Uint8Array> | null = null;
  const files = async (environment: SetupEnvironment): Promise<readonly InstallerFile[]> => {
    if (await hasSystemChromium(environment)) return [];
    const root = path.join(environment.xdgDataHome, 'khala', 'versions', input.version, 'chromium', 'chrome-linux64');
    return pinned.files.map(file => ({
      path: path.join(root, ...catalogPath(file.path)), component: 'payload' as const,
      postimage: `sha256:${file.sha256}` as Sha256Digest, mode: file.mode,
      harnesses: ['claude', 'codex', 'opencode', 'cursor'] as const,
      ...(file.path === 'chrome' ? { acquisition: `Confirmation downloads pinned Chromium ${pinned.chromeVersion} with Playwright-core ${pinned.playwrightCore}, verifies every file, and installs up to ${Math.ceil(pinned.files.reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024)} MiB under ${root}.` } : {}),
      ...(hydrated?.get(file.path) === undefined ? {} : { bytes: hydrated.get(file.path)! }),
    }));
  };
  const prepareConfirmed = async (command: 'setup' | 'remove', environment: SetupEnvironment): Promise<() => Promise<void>> => {
    if (command !== 'setup' || await hasSystemChromium(environment)) return async () => {};
    // HOME shares the installation's disk budget; /tmp may be a quota-limited tmpfs.
    const staging = await fs.mkdtemp(path.join(environment.home, '.khala-chromium-'));
    await fs.chmod(staging, 0o700);
    try {
      await (input.stage ?? stagePinnedChromium)(input.driverDirectory, staging);
      const root = path.join(staging, `chromium-${pinned.chromiumRevision}`, 'chrome-linux64');
      const actual = await regularFiles(root);
      const names = [...expected.keys()].sort();
      if (actual.length !== names.length || actual.some((name, index) => name !== names[index]))
        throw new Error('pinned browser file inventory changed');
      const bytes = new Map<string, Uint8Array>();
      for (const file of pinned.files) {
        const value = new Uint8Array(await fs.readFile(path.join(root, ...catalogPath(file.path))));
        if (value.byteLength !== file.bytes || digest(value) !== `sha256:${file.sha256}`)
          throw new Error('pinned browser asset changed');
        bytes.set(file.path, value);
      }
      hydrated = bytes;
      return async () => { hydrated = null; };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  };
  return { files, prepareConfirmed };
}
