import { describe, expect, it } from 'vitest';
import { createDisk, createMemoryLockManager, owner, rig } from './fakes';
import { createWebLockProvider } from './ownership';
import { createBrowserDeviceService } from './service';

const alice = owner('owner_alice');

describe('cross-tab ownership', () => {
  it('lets exactly one of two contending tabs own writable crypto state', async () => {
    const disk = createDisk();
    const tabA = rig(disk);
    const tabB = rig(disk, { lockWaitMs: 20 });
    const a = createBrowserDeviceService(tabA.deps);
    const b = createBrowserDeviceService(tabB.deps);

    const [ra, rb] = await Promise.all([a.ensureReady(alice), b.ensureReady(alice)]);

    expect(ra).toMatchObject({ kind: 'ok', value: { state: 'ready' } });
    expect(rb).toEqual({ kind: 'unavailable', retryable: true });
    expect(b.current()).toEqual({ deviceId: null, state: 'failed', generation: 1, reason: 'storage_unavailable' });
    // The follower never reserved the store or opened a client.
    expect(tabB.log).toEqual([]);
    expect(await b.use(async () => 'write')).toEqual({ kind: 'rejected', code: 'not_ready' });
  });

  it('hands ownership to a waiting tab when the owner ends, without cloning state', async () => {
    const disk = createDisk();
    const a = createBrowserDeviceService(rig(disk).deps);
    await a.ensureReady(alice);
    const fingerprint = disk.markers.get(alice)?.fingerprint;

    const tabB = rig(disk, { lockWaitMs: 5_000 });
    const b = createBrowserDeviceService(tabB.deps);
    const waiting = b.ensureReady(alice);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(b.current().state).toBe('initializing');
    expect(tabB.log).toEqual([]);

    await a.stop();
    const result = await waiting;

    expect(result).toMatchObject({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'ready' } });
    expect(await tabB.engines[0]?.identity()).toEqual({ fingerprint, created: false });
    expect(disk.stores.size).toBe(1);
  });

  it('fails explicitly when no exclusive browser lock exists', async () => {
    const tab = rig(createDisk(), { locks: createWebLockProvider(null) });
    const service = createBrowserDeviceService(tab.deps);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'rejected', code: 'unsupported_environment' });
    expect(service.current()).toEqual({ deviceId: null, state: 'failed', generation: 1, reason: 'unsupported_environment' });
    expect(tab.log).toEqual([]);
  });
});

describe('createWebLockProvider', () => {
  it('grants, times out and aborts against an exclusive lock manager', async () => {
    const provider = createWebLockProvider(createMemoryLockManager());
    const never = new AbortController().signal;

    const first = await provider.acquire(alice, { waitMs: 50, signal: never });
    expect(first.kind).toBe('acquired');
    expect(await provider.acquire(alice, { waitMs: 10, signal: never })).toEqual({ kind: 'timeout' });
    expect((await provider.acquire(owner('owner_bob'), { waitMs: 10, signal: never })).kind).toBe('acquired');

    const controller = new AbortController();
    const aborted = provider.acquire(alice, { waitMs: 5_000, signal: controller.signal });
    controller.abort();
    expect(await aborted).toEqual({ kind: 'aborted' });

    if (first.kind === 'acquired') {
      first.lease.release();
      first.lease.release();
    }
    expect((await provider.acquire(alice, { waitMs: 10, signal: never })).kind).toBe('acquired');
  });

  it('treats a lock manager that refuses requests as unsupported', async () => {
    const provider = createWebLockProvider({ request: () => Promise.reject(new Error('SecurityError')) });
    expect(await provider.acquire(alice, { waitMs: 1_000, signal: new AbortController().signal })).toEqual({ kind: 'unsupported' });
  });
});
