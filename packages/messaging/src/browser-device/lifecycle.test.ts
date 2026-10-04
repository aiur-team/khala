import { describe, expect, it } from 'vitest';
import { type DeviceView, decodeDeviceView } from '@khala/contracts/messaging/index';
import { createDisk, device, owner, rig, session } from './fakes';
import { checkIdentity } from './lifecycle';
import { createBrowserDeviceService } from './service';

const alice = owner('owner_alice');

function record(service: ReturnType<typeof createBrowserDeviceService>): DeviceView[] {
  const views: DeviceView[] = [];
  service.observe(view => views.push(view));
  return views;
}

/** Every published view must satisfy the contract decoder, reasons included. */
function expectContractViews(views: DeviceView[]) {
  for (const view of views) expect(decodeDeviceView(JSON.parse(JSON.stringify(view)))).toEqual({ ok: true, value: view });
}

describe('createBrowserDeviceService', () => {
  it('surfaces an identity conflict as recovery required before opening a crypto store', async () => {
    const { deps, log } = rig(createDisk());
    const service = createBrowserDeviceService({ ...deps, credentials: {
      resolve: async () => ({ kind: 'unavailable', reason: 'recovery_required' }),
    } });
    expect(await service.ensureReady(alice)).toMatchObject({ kind: 'unavailable' });
    expect(service.current()).toMatchObject({ state: 'failed', reason: 'recovery_required' });
    expect(log).not.toContain('open:owner_alice');
  });
  it('initialises automatically on the signed-in path and publishes contract views', async () => {
    const disk = createDisk();
    const { deps } = rig(disk);
    const service = createBrowserDeviceService(deps);
    const views = record(service);

    const result = await service.ensureReady(alice);

    expect(result).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'ready', generation: 1, reason: null } });
    expect(views.map(v => v.state)).toEqual(['initializing', 'ready']);
    expect(disk.markers.get(alice)).toEqual({ deviceId: 'DEVICE_A', fingerprint: disk.stores.get('store.owner_alice.DEVICE_A') });
    expectContractViews(views);
  });

  it('coalesces concurrent ensureReady calls into one client generation', async () => {
    const { deps, log } = rig(createDisk());
    const service = createBrowserDeviceService(deps);

    const [a, b, c] = await Promise.all([service.ensureReady(alice), service.ensureReady(alice), service.ensureReady(alice)]);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.kind === 'ok' && a.value.generation).toBe(1);
    expect(log.filter(entry => entry.startsWith('open:'))).toHaveLength(1);
    expect((await service.ensureReady(alice))).toEqual(a);
    expect(log.filter(entry => entry.startsWith('open:'))).toHaveLength(1);
  });

  it('closes the partially opened store and releases the lock when SDK setup fails', async () => {
    const disk = createDisk();
    const failing = rig(disk, { engine: { failOpen: true } });
    const service = createBrowserDeviceService(failing.deps);

    const result = await service.ensureReady(alice);

    expect(result).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'failed', generation: 1, reason: 'initialization_failed' } });
    expect(failing.log).toEqual(['store:owner_alice', 'open:owner_alice', 'store-close:owner_alice']);
    // The lease was released: another tab can take ownership immediately.
    const next = createBrowserDeviceService(rig(disk).deps);
    expect((await next.ensureReady(alice)).kind).toBe('ok');
    expect(next.current().state).toBe('ready');
  });

  it.each(['store', 'engine', 'markers'] as const)('fails, but never hands the lock on, when %s setup never settles', async step => {
    const disk = createDisk();
    const { deps } = rig(disk);
    const never = <T>() => new Promise<T>(() => undefined);
    const service = createBrowserDeviceService({
      ...deps,
      engineTimeoutMs: 20,
      ...(step === 'store' ? { stores: { open: never } } : {}),
      ...(step === 'engine' ? { engines: { open: never } } : {}),
      ...(step === 'markers' ? { markers: { ...deps.markers, get: never } } : {}),
    });

    const result = await service.ensureReady(alice);

    expect(result.kind === 'ok' ? result.value.state : result.kind).not.toBe('ready');
    expect(service.current()).toMatchObject({ state: 'failed' });
    // The step may still be writing the store, so another tab must not open it.
    const next = createBrowserDeviceService(rig(disk).deps);
    expect((await next.ensureReady(alice)).kind).toBe('unavailable');
    expect(next.current()).toMatchObject({ state: 'failed', reason: 'lease_unavailable' });
  });

  it.each(['engine', 'store', 'marker'] as const)(
    'keeps the lock until a timed-out %s step settles, so no second tab becomes ready meanwhile',
    async kind => {
      const disk = createDisk();
      const events: string[] = [];
      const a = rig(disk);
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const late = async <T>(write: () => Promise<T>): Promise<T> => {
        events.push(`A:${kind}-start`);
        await sleep(80);
        const value = await write();
        events.push(`A:${kind}-wrote-store`);
        return value;
      };
      const service = createBrowserDeviceService({
        ...a.deps,
        engineTimeoutMs: 20,
        ...(kind === 'engine' ? { engines: { open: input => late(async () => {
          const engine = await a.deps.engines.open(input);
          return { ...engine, close: async () => { await engine.close(); events.push('A:late-close'); } };
        }) } } : {}),
        ...(kind === 'store' ? { stores: { open: (...args) => late(async () => {
          const store = await a.deps.stores.open(...args);
          return { ...store, close: async () => { await store.close(); events.push('A:late-close'); } };
        }) } } : {}),
        ...(kind === 'marker' ? { markers: { ...a.deps.markers, put: (...args) => late(async () => {
          await a.deps.markers.put(...args);
        }) } } : {}),
      });

      const first = await service.ensureReady(alice);
      events.push(`A:result=${first.kind === 'ok' ? first.value.state : first.kind}`);
      const other = createBrowserDeviceService(rig(disk, { lockWaitMs: 1_000 }).deps);
      const second = await other.ensureReady(alice);
      events.push(`B:result=${second.kind === 'ok' ? second.value.state : second.kind}`);

      // A late marker write has nothing to close; B waits for the write itself.
      expect(events).toEqual([`A:${kind}-start`, 'A:result=failed', `A:${kind}-wrote-store`,
        ...(kind === 'marker' ? [] : ['A:late-close']), 'B:result=ready']);
    },
  );

  it('enters lost, not ready with new keys, when identity is missing for a device the server knows', async () => {
    const disk = createDisk();
    const { deps, engines } = rig(disk, { credentials: { owner_alice: session('DEVICE_OLD', 'fp-published-old') } });
    const service = createBrowserDeviceService(deps);

    const result = await service.ensureReady(alice);

    expect(result).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_OLD', state: 'lost', generation: 1, reason: 'key_material_missing' } });
    expect(engines[0]?.started).toBe(false);
    expect(engines[0]?.closed).toBe(true);
    expect(disk.markers.has(alice)).toBe(false);
  });

  it('reports cleared crypto storage as lost and never reopens it as the old device', async () => {
    const disk = createDisk();
    const before = createBrowserDeviceService(rig(disk).deps);
    await before.ensureReady(alice);
    await before.stop();
    disk.stores.clear();

    const { deps, engines } = rig(disk);
    const service = createBrowserDeviceService(deps);
    const first = await service.ensureReady(alice);
    const retry = await service.ensureReady(alice);

    expect(first).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'lost', generation: 1, reason: 'storage_cleared' } });
    expect(retry).toEqual(first);
    expect(engines).toHaveLength(1);
    expect(engines[0]?.started).toBe(false);
  });

  it('keeps the same device identity across a restart', async () => {
    const disk = createDisk();
    const first = createBrowserDeviceService(rig(disk).deps);
    await first.ensureReady(alice);
    const marker = disk.markers.get(alice);
    await first.stop();

    const restarted = rig(disk);
    const service = createBrowserDeviceService(restarted.deps);
    const result = await service.ensureReady(alice);

    expect(result.kind === 'ok' && result.value).toMatchObject({ deviceId: 'DEVICE_A', state: 'ready' });
    expect(await restarted.engines[0]?.identity()).toEqual({ fingerprint: marker?.fingerprint, created: false });
    expect(disk.markers.get(alice)).toEqual(marker);
  });

  it('refuses readiness when the identity marker cannot be written', async () => {
    const disk = createDisk();
    const { deps, engines } = rig(disk, { markers: { failPut: true } });
    const service = createBrowserDeviceService(deps);

    const result = await service.ensureReady(alice);

    expect(result).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'failed', generation: 1, reason: 'storage_unavailable' } });
    expect(engines[0]?.started).toBe(false);
    expect(engines[0]?.closed).toBe(true);
  });

  it('fails with storage_unavailable when the crypto store cannot be reserved', async () => {
    const { deps, log } = rig(createDisk(), { stores: { fail: true } });
    const service = createBrowserDeviceService(deps);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'failed', generation: 1, reason: 'storage_unavailable' } });
    expect(log.some(entry => entry.startsWith('open:'))).toBe(false);
  });

  it('refuses another owner and reports identity outages as retryable', async () => {
    const { deps, identity } = rig(createDisk());
    const service = createBrowserDeviceService(deps);

    expect(await service.ensureReady(owner('owner_mallory'))).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    identity.set({ kind: 'unavailable', retryable: true });
    expect(await service.ensureReady(alice)).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current().state).toBe('new');
  });

  it('aborting a wait returns outcome_unknown while initialisation carries on', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const { deps } = rig(createDisk(), { engine: { onStart: () => held } });
    const service = createBrowserDeviceService(deps);
    const controller = new AbortController();

    const waiting = service.ensureReady(alice, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const aborted = await waiting;
    release();
    const settled = await service.ensureReady(alice);

    expect(aborted.kind).toBe('outcome_unknown');
    expect(settled.kind === 'ok' && settled.value.state).toBe('ready');
  });

  it('queues crypto operations behind initialisation and rejects them before it', async () => {
    const { deps } = rig(createDisk());
    const service = createBrowserDeviceService(deps);

    expect(await service.use(alice, async () => 'early')).toEqual({ kind: 'rejected', code: 'not_ready' });

    const init = service.ensureReady(alice);
    const queued = service.use(alice, async context => `${context.deviceId}@${context.generation}`);
    await init;

    expect(await queued).toEqual({ kind: 'ok', value: 'DEVICE_A@1' });
  });

  it('leaves lost only after the loss is accepted, and then only with a new device', async () => {
    const disk = createDisk();
    let current = session('DEVICE_OLD', 'fp-published-old');
    const { deps } = rig(disk, { credentials: { owner_alice: async () => current } });
    const service = createBrowserDeviceService(deps);
    await service.ensureReady(alice);

    expect(await service.acceptLoss(owner('owner_bob'))).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect((await service.acceptLoss(alice)).kind).toBe('ok');
    // The same server device still refuses a fresh keyset.
    expect(await service.ensureReady(alice)).toMatchObject({ kind: 'ok', value: { state: 'lost', reason: 'key_material_missing' } });

    await service.acceptLoss(alice);
    current = session('DEVICE_NEW');
    const result = await service.ensureReady(alice);
    expect(result).toMatchObject({ kind: 'ok', value: { deviceId: 'DEVICE_NEW', state: 'ready' } });
    expect(await service.acceptLoss(alice)).toEqual({ kind: 'rejected', code: 'not_lost' });
  });
});

describe('checkIdentity', () => {
  const marker = { deviceId: device('D'), fingerprint: 'fp' };
  const known = { deviceId: device('D'), publishedFingerprint: 'fp', credentials: null };
  const unpublished = { ...known, publishedFingerprint: null };

  it('resumes only the exact enrolled identity', () => {
    expect(checkIdentity(marker, known, { fingerprint: 'fp', created: false })).toBe('resume');
    expect(checkIdentity(marker, unpublished, { fingerprint: 'fp', created: false })).toBe('resume');
    expect(checkIdentity(marker, known, { fingerprint: 'fp2', created: false })).toEqual({ lost: 'storage_cleared' });
    expect(checkIdentity(marker, known, { fingerprint: 'fp', created: true })).toEqual({ lost: 'storage_cleared' });
  });

  it('refuses local keys that differ from the keys the server published', () => {
    expect(checkIdentity(null, known, { fingerprint: 'fresh', created: true })).toEqual({ lost: 'key_material_missing' });
    // Keys left behind by an earlier refused attempt are still not the published ones.
    expect(checkIdentity(null, known, { fingerprint: 'leftover', created: false })).toEqual({ lost: 'key_material_missing' });
    expect(checkIdentity({ deviceId: device('D'), fingerprint: 'x' }, known, { fingerprint: 'x', created: false }))
      .toEqual({ lost: 'key_material_missing' });
  });

  it('enrols a device the server holds no keys for, or whose published keys are local', () => {
    expect(checkIdentity(null, unpublished, { fingerprint: 'fp', created: true })).toBe('enrol');
    expect(checkIdentity(null, known, { fingerprint: 'fp', created: false })).toBe('enrol');
    expect(checkIdentity({ deviceId: device('OTHER'), fingerprint: 'old' }, unpublished, { fingerprint: 'fp', created: true })).toBe('enrol');
  });
});
