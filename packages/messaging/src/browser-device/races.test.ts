// Interleavings where a slow request must not act on state a newer request owns.

import { describe, expect, it } from 'vitest';
import { createDisk, owner, rig, session } from './fakes';
import { createBrowserDeviceService } from './service';

const alice = owner('owner_alice');
const bob = owner('owner_bob');
const both = { owner_alice: session('DEVICE_A'), owner_bob: session('DEVICE_B') };

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('use() is bound to its owner and generation', () => {
  it('refuses another owner and never runs a queued operation on the next account', async () => {
    const aliceStart = gate();
    const tab = rig(createDisk(), {
      credentials: both,
      engine: { onStart: engine => (engine.input.ownerId === alice ? aliceStart.promise : undefined) },
    });
    const service = createBrowserDeviceService(tab.deps);
    const ran: string[] = [];

    const aliceInit = service.ensureReady(alice);
    await tick();
    const queued = service.use(alice, async context => { ran.push(context.ownerId); return 'alice-secret'; });
    tab.identity.signIn('owner_bob');
    const bobInit = service.ensureReady(bob);
    aliceStart.open();

    expect(await aliceInit).toEqual({ kind: 'unavailable', retryable: true });
    expect(await bobInit).toMatchObject({ kind: 'ok', value: { state: 'ready', deviceId: 'DEVICE_B' } });
    expect(await queued).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(ran).toEqual([]);
    expect(await service.use(alice, async () => 'x')).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
  });

  it('discards a result produced after its generation ended', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    const result = await service.use(alice, async () => {
      await service.stop();
      return 'plaintext from an ended generation';
    });

    expect(result).toEqual({ kind: 'rejected', code: 'not_ready' });
  });

  it('returns at once for an already aborted signal', async () => {
    const tab = rig(createDisk(), { engine: { onStart: () => new Promise(() => undefined) } });
    const service = createBrowserDeviceService(tab.deps);
    void service.ensureReady(alice);
    await tick();

    const controller = new AbortController();
    controller.abort();
    expect(await service.use(alice, async () => 'x', { signal: controller.signal })).toEqual({ kind: 'unavailable', retryable: true });
  });
});

describe('superseded requests publish nothing', () => {
  it('a slow sign-out does not overwrite the next account', async () => {
    const closing = gate();
    const tab = rig(createDisk(), { credentials: both, engine: { onClose: () => closing.promise } });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.identity.set({ kind: 'signed_out' });
    const signOut = service.ensureReady(alice);
    await tick();
    tab.identity.signIn('owner_bob');
    const bobReady = await service.ensureReady(bob);
    closing.open();

    expect(bobReady).toMatchObject({ kind: 'ok', value: { state: 'ready', deviceId: 'DEVICE_B' } });
    expect(await signOut).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current()).toMatchObject({ state: 'ready', deviceId: 'DEVICE_B' });
  });

  it('a stale request cannot retire the generation a newer request opened', async () => {
    const closing = gate();
    const tab = rig(createDisk(), { credentials: both, lockWaitMs: 5_000, engine: { onClose: () => closing.promise } });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.identity.signIn('owner_bob');
    const toBob = service.ensureReady(bob);
    await tick();
    tab.identity.signIn('owner_alice');
    const backToAlice = service.ensureReady(alice);
    await tick();
    closing.open();

    expect(await toBob).toEqual({ kind: 'unavailable', retryable: true });
    expect(await backToAlice).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'ready', generation: 2, reason: null } });
    expect(service.current()).toEqual({ deviceId: 'DEVICE_A', state: 'ready', generation: 2, reason: null });
    expect(tab.log.filter(entry => entry.startsWith('open:'))).toEqual(['open:owner_alice', 'open:owner_alice']);
  });

  it('a sign-out during the lock wait prevents the device from becoming ready', async () => {
    const disk = createDisk();
    const owner1 = createBrowserDeviceService(rig(disk).deps);
    await owner1.ensureReady(alice);
    const waiter = rig(disk, { lockWaitMs: 5_000 });
    const service = createBrowserDeviceService(waiter.deps);

    const waiting = service.ensureReady(alice);
    await tick();
    waiter.identity.set({ kind: 'signed_out' });
    await owner1.stop();

    expect(await waiting).toEqual({ kind: 'ok', value: { deviceId: null, state: 'failed', generation: 1, reason: 'signed_out' } });
    expect(waiter.log).toEqual([]);
  });

  it('a slow loss acceptance does not clobber the next account', async () => {
    const clearing = gate();
    const tab = rig(createDisk(), { credentials: { owner_alice: session('DEVICE_OLD', 'fp-published-old'), owner_bob: session('DEVICE_B') } });
    const markers = tab.deps.markers;
    const service = createBrowserDeviceService({
      ...tab.deps,
      markers: { ...markers, clear: async ownerId => { await clearing.promise; await markers.clear(ownerId); } },
    });
    await service.ensureReady(alice);

    const accepting = service.acceptLoss(alice);
    tab.identity.signIn('owner_bob');
    await service.ensureReady(bob);
    clearing.open();

    expect(await accepting).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current()).toMatchObject({ state: 'ready', deviceId: 'DEVICE_B' });
  });
});

describe('port failures stay inside OperationResult', () => {
  it('turns a throwing identity port into unavailable, with or without a signal', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService({ ...tab.deps, identity: { ...tab.deps.identity, current: () => Promise.reject(new Error('boom')) } });

    expect(await service.ensureReady(alice)).toEqual({ kind: 'unavailable', retryable: true });
    expect(await service.ensureReady(alice, { signal: new AbortController().signal })).toEqual({ kind: 'unavailable', retryable: true });
  });

  it('turns a failed marker clear into unavailable and stays lost', async () => {
    const tab = rig(createDisk(), { credentials: { owner_alice: session('DEVICE_OLD', 'fp-published-old') } });
    const service = createBrowserDeviceService({ ...tab.deps, markers: { ...tab.deps.markers, clear: () => Promise.reject(new Error('io')) } });
    await service.ensureReady(alice);

    expect(await service.acceptLoss(alice)).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current().state).toBe('lost');
  });

  it('reports a credential outage as retryable without opening storage', async () => {
    const tab = rig(createDisk(), { credentials: { owner_alice: { kind: 'unavailable' } } });
    const service = createBrowserDeviceService(tab.deps);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current()).toEqual({ deviceId: null, state: 'failed', generation: 1, reason: 'initialization_failed' });
    expect(tab.log).toEqual([]);
  });
});

describe('remaining transitions', () => {
  it('keeps lost when the owner signs out', async () => {
    const tab = rig(createDisk(), { credentials: { owner_alice: session('DEVICE_OLD', 'fp-published-old') } });
    const service = createBrowserDeviceService(tab.deps);
    const lost = await service.ensureReady(alice);

    tab.identity.set({ kind: 'signed_out' });
    expect(await service.ensureReady(alice)).toEqual(lost);
  });

  it('fails a ready device whose storage fails underneath it', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.engines[0]!.input.emit('storage_failed');
    await tick();

    expect(service.current()).toEqual({ deviceId: 'DEVICE_A', state: 'failed', generation: 1, reason: 'storage_unavailable' });
    expect(tab.engines[0]?.closed).toBe(true);
  });
});
