import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');
const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

type Harness = {
  ensure(input: { ownerId: string; deviceId: string; publishedFingerprint: string | null; lockWaitMs: number }): Promise<unknown>;
  current(): unknown;
  fingerprint(): Promise<string | null>;
  encrypt(text: string): Promise<string | null>;
  decrypt(event: string): Promise<unknown>;
  clearCryptoStore(input: { ownerId: string; deviceId: string }): Promise<void>;
  clearMarkers(): Promise<void>;
};

/** Calls one harness method inside the page. */
function call<K extends keyof Harness>(page: Page, method: K, ...args: Parameters<Harness[K]>): Promise<Awaited<ReturnType<Harness[K]>>> {
  return page.evaluate(
    ([name, rest]) => {
      const harness = (globalThis as unknown as { khalaDevice: Record<string, (...a: unknown[]) => unknown> }).khalaDevice;
      return harness[name as string]!(...(rest as unknown[]));
    },
    [method, args] as const,
  ) as Promise<Awaited<ReturnType<Harness[K]>>>;
}

/** Chromium's profile `SingletonLock` links to `<host>-<pid>` of the live browser process. */
async function browserPid(profile: string): Promise<string> {
  return (await readlink(join(profile, 'SingletonLock'))).split('-').at(-1)!;
}

const alice = { ownerId: 'owner_alice', deviceId: 'DEVICE_A' };
const ready = (generation: number) => ({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'ready', generation, reason: null } });

// A real Chromium profile directory reused across full browser process restarts.
// The engine behind the service is the harness's Web Crypto stand-in (see
// browser-harness/main.ts); Web Locks, IndexedDB and the lifecycle are production code.
test('browser device lifecycle survives a full browser restart and refuses lost keys', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-device-dist-'));
  // Chromium's singleton socket path is length-limited, so the profile uses /tmp.
  const profile = await mkdtemp(join('/tmp', 'khala-device-profile-'));
  let server: PreviewServer | undefined;
  let context: BrowserContext | undefined;
  const launch = async () => chromium.launchPersistentContext(profile, {
    executablePath, headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile },
  });
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = server.resolvedUrls!.local[0]!;
    const open = async (target: BrowserContext) => {
      const page = await target.newPage();
      await page.goto(url);
      await page.waitForFunction(() => 'khalaDevice' in globalThis);
      return page;
    };

    // First run: automatic enrolment, then encrypt an event with the device's keys.
    context = await launch();
    let page = await open(context);
    const firstPid = await browserPid(profile);
    assert.deepEqual(await call(page, 'ensure', { ...alice, publishedFingerprint: null, lockWaitMs: 1_000 }), ready(1));
    const fingerprint = await call(page, 'fingerprint');
    assert.match(fingerprint ?? '', /^[0-9a-f]{64}$/);
    const event = await call(page, 'encrypt', 'written before restart');
    assert.ok(event);
    await context.close();

    // AE1: a new browser process over the same profile keeps the device and decrypts the old event.
    context = await launch();
    page = await open(context);
    assert.notEqual(await browserPid(profile), firstPid, 'restart must be a new browser process, not a reload');
    assert.deepEqual(await call(page, 'ensure', { ...alice, publishedFingerprint: fingerprint, lockWaitMs: 1_000 }), ready(1));
    assert.equal(await call(page, 'fingerprint'), fingerprint);
    assert.deepEqual(await call(page, 'decrypt', event!), { kind: 'plaintext', text: 'written before restart' });

    // Two tabs contend: the second never becomes a writer while the first holds the lock.
    const second = await open(context);
    assert.deepEqual(await call(second, 'ensure', { ...alice, publishedFingerprint: fingerprint, lockWaitMs: 300 }), { kind: 'unavailable', retryable: true });
    assert.deepEqual(await call(second, 'current'), { deviceId: null, state: 'failed', generation: 1, reason: 'storage_unavailable' });
    assert.deepEqual(await call(second, 'decrypt', event!), { kind: 'rejected' });

    // Closing the owning tab releases the lock; the survivor opens the same store.
    await page.close();
    assert.deepEqual(await call(second, 'ensure', { ...alice, publishedFingerprint: fingerprint, lockWaitMs: 5_000 }), ready(2));
    assert.equal(await call(second, 'fingerprint'), fingerprint);
    assert.deepEqual(await call(second, 'decrypt', event!), { kind: 'plaintext', text: 'written before restart' });

    // Cleared crypto storage with the marker intact: lost, and no old plaintext.
    await call(second, 'clearCryptoStore', alice);
    assert.deepEqual(
      await call(second, 'ensure', { ...alice, publishedFingerprint: fingerprint, lockWaitMs: 1_000 }),
      { kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'lost', generation: 4, reason: 'storage_cleared' } },
    );
    assert.deepEqual(await call(second, 'decrypt', event!), { kind: 'rejected' });
    await context.close();

    // Whole-profile style loss (marker gone too) against a server that still holds the old keys.
    context = await launch();
    page = await open(context);
    await call(page, 'clearMarkers');
    await call(page, 'clearCryptoStore', alice);
    assert.deepEqual(
      await call(page, 'ensure', { ...alice, publishedFingerprint: fingerprint, lockWaitMs: 1_000 }),
      { kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'lost', generation: 1, reason: 'key_material_missing' } },
    );
    assert.deepEqual(await call(page, 'decrypt', event!), { kind: 'rejected' });
  } finally {
    await context?.close().catch(() => undefined);
    await new Promise<void>(resolve => server ? server.httpServer.close(() => resolve()) : resolve());
    await rm(outDir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
