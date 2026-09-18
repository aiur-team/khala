// A device generation belongs to one signed-in principal. Once the identity port
// reports someone else, or nobody, that generation must stop being usable.

import { describe, expect, it } from 'vitest';
import type { IdentityState } from '@khala/contracts/messaging/index';
import { createDisk, owner, principal, rig, session } from './fakes';
import type { OwnerLockProvider } from './ownership';
import { createBrowserDeviceService } from './service';

const alice = owner('owner_alice');
const both = { owner_alice: session('DEVICE_A'), owner_bob: session('DEVICE_B') };

function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => { open = resolve; });
  return { promise, open };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Alice again, but authenticated through another provider account. */
const aliceElsewhere: IdentityState = { kind: 'signed_in', principal: { ...principal('owner_alice'), providerSubject: 'sub-someone-else' } };

describe('a ready device whose owner is no longer signed in', () => {
  it('is retired when ensureReady reports owner_mismatch', async () => {
    const tab = rig(createDisk(), { credentials: both });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.identity.signIn('owner_bob');

    expect(await service.ensureReady(alice)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
    expect(tab.engines[0]?.closed).toBe(true);
    expect(await service.use(alice, async () => 'alice transcript')).toEqual({ kind: 'rejected', code: 'not_ready' });
  });

  it('clears a settled view of the previous owner on owner_mismatch', async () => {
    const tab = rig(createDisk(), { credentials: { owner_alice: session('DEVICE_OLD', 'fp-published-old') } });
    const service = createBrowserDeviceService(tab.deps);
    expect(await service.ensureReady(alice)).toMatchObject({ kind: 'ok', value: { state: 'lost', deviceId: 'DEVICE_OLD' } });

    tab.identity.signIn('owner_bob');

    expect(await service.ensureReady(alice)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
  });

  it("leaves the signed-in owner's device alone when asked for another owner", async () => {
    const tab = rig(createDisk(), { ownerId: 'owner_bob', credentials: both });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(owner('owner_bob'));

    expect(await service.ensureReady(alice)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(service.current()).toEqual({ deviceId: 'DEVICE_B', state: 'ready', generation: 1, reason: null });
    expect(tab.engines[0]?.closed).toBe(false);
  });

  it('is locked by use() once the owner signs out, and the operation never runs', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);
    const ran: string[] = [];

    tab.identity.set({ kind: 'signed_out' });

    expect(await service.use(alice, async () => { ran.push('alice'); return 'alice transcript'; })).toEqual({ kind: 'rejected', code: 'not_ready' });
    expect(ran).toEqual([]);
    expect(service.current()).toEqual({ deviceId: 'DEVICE_A', state: 'locked', generation: 1, reason: 'signed_out' });
    expect(tab.engines[0]?.closed).toBe(true);
  });

  it('is retired by use() after an account switch, and the operation never runs', async () => {
    const tab = rig(createDisk(), { credentials: both });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);
    const ran: string[] = [];

    tab.identity.signIn('owner_bob');

    expect(await service.use(alice, async () => { ran.push('alice'); return 'alice transcript'; })).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(ran).toEqual([]);
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
    expect(tab.engines[0]?.closed).toBe(true);
  });

  it('is retired by use() when the same owner id comes back through another provider account', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.identity.set(aliceElsewhere);

    expect(await service.use(alice, async () => 'alice transcript')).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(tab.engines[0]?.closed).toBe(true);
  });

  it('discards a result when the identity changes while the operation runs', async () => {
    const tab = rig(createDisk(), { credentials: both });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    const result = await service.use(alice, async () => {
      tab.identity.signIn('owner_bob');
      return 'alice transcript';
    });

    expect(result).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(tab.engines[0]?.closed).toBe(true);
  });

  it('keeps the generation through a transient identity outage', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.identity.set({ kind: 'unavailable', retryable: true });
    expect(await service.use(alice, async () => 'x')).toEqual({ kind: 'unavailable', retryable: true });
    expect(tab.engines[0]?.closed).toBe(false);

    tab.identity.signIn('owner_alice');
    expect(await service.use(alice, async () => 'x')).toEqual({ kind: 'ok', value: 'x' });
  });

  it('re-initialises when ensureReady sees the same owner id through another provider account', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.identity.set(aliceElsewhere);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'ready', generation: 2, reason: null } });
    expect(tab.engines[0]?.closed).toBe(true);
    expect(tab.engines).toHaveLength(2);
  });
});

describe('an identity change before ready is published', () => {
  it('an account switch during the lock wait never yields ready', async () => {
    const disk = createDisk();
    const holder = createBrowserDeviceService(rig(disk).deps);
    await holder.ensureReady(alice);
    const waiter = rig(disk, { credentials: both, lockWaitMs: 5_000 });
    const service = createBrowserDeviceService(waiter.deps);

    const waiting = service.ensureReady(alice);
    await tick();
    waiter.identity.signIn('owner_bob');
    await holder.stop();

    expect(await waiting).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
    expect(waiter.log).toEqual([]);
  });

  it('an account switch during initialisation never yields ready', async () => {
    const tab = rig(createDisk(), { credentials: both, engine: { onStart: () => { tab.identity.signIn('owner_bob'); } } });
    const service = createBrowserDeviceService(tab.deps);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
    expect(tab.engines[0]?.closed).toBe(true);
  });

  it('a provider account change during initialisation never yields ready', async () => {
    const tab = rig(createDisk(), { engine: { onStart: () => { tab.identity.set(aliceElsewhere); } } });
    const service = createBrowserDeviceService(tab.deps);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(service.current().state).toBe('new');
    expect(tab.engines[0]?.closed).toBe(true);
  });
});

describe('stale requests', () => {
  it('a superseded identity read cannot retire the generation a newer request opened', async () => {
    const tab = rig(createDisk(), { credentials: both });
    const staleRead = gate<IdentityState>();
    let reads = 0;
    const service = createBrowserDeviceService({
      ...tab.deps,
      identity: { ...tab.deps.identity, current: () => (++reads === 1 ? staleRead.promise : tab.deps.identity.current()) },
    });

    const stale = service.ensureReady(alice);
    await tick();
    await service.stop();
    expect(await service.ensureReady(alice)).toMatchObject({ kind: 'ok', value: { state: 'ready' } });
    staleRead.open({ kind: 'signed_in', principal: principal('owner_bob') });

    expect(await stale).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current()).toMatchObject({ state: 'ready', deviceId: 'DEVICE_A' });
    expect(tab.engines.at(-1)?.closed).toBe(false);
  });

  it('a lock wait that ends after stop() publishes nothing', async () => {
    const tab = rig(createDisk());
    const waited = gate<void>();
    // A provider that ignores the abort and reports a timeout later.
    const locks: OwnerLockProvider = { acquire: async () => { await waited.promise; return { kind: 'timeout' }; } };
    const service = createBrowserDeviceService({ ...tab.deps, locks });

    const init = service.ensureReady(alice);
    await tick();
    await service.stop();
    waited.open();

    expect(await init).toEqual({ kind: 'unavailable', retryable: true });
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
  });

  it('closes a store that finished opening after its generation ended', async () => {
    const tab = rig(createDisk());
    const opening = gate<void>();
    const stores = tab.deps.stores;
    const service = createBrowserDeviceService({
      ...tab.deps,
      stores: { open: async (...args) => { await opening.promise; return stores.open(...args); } },
    });

    const init = service.ensureReady(alice);
    await tick();
    await service.stop();
    opening.open();

    expect(await init).toEqual({ kind: 'unavailable', retryable: true });
    expect(tab.log).toEqual(['store:owner_alice', 'store-close:owner_alice']);
  });
});

describe('use() failures stay inside OperationResult', () => {
  it('turns a throwing operation into operation_failed without surfacing the error', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    const result = await service.use(alice, async () => { throw new Error('olm session secret'); });

    expect(result).toEqual({ kind: 'rejected', code: 'operation_failed' });
    expect(service.current().state).toBe('ready');
  });
});

describe('engine time bounds', () => {
  it('fails initialisation when engine.start never settles', async () => {
    const tab = rig(createDisk(), { engine: { onStart: () => new Promise(() => undefined) } });
    const service = createBrowserDeviceService({ ...tab.deps, engineTimeoutMs: 20 });

    expect(await service.ensureReady(alice)).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'failed', generation: 1, reason: 'initialization_failed' } });
    expect(tab.log).toContain('close:owner_alice');
  });

  it('keeps the store and owner lock held when engine.close never settles', async () => {
    const disk = createDisk();
    const tab = rig(disk, { engine: { onClose: () => new Promise(() => undefined) } });
    const service = createBrowserDeviceService({ ...tab.deps, engineTimeoutMs: 20 });
    await service.ensureReady(alice);

    await service.stop();

    expect(service.current().state).toBe('new');
    expect(tab.log).not.toContain('store-close:owner_alice');
    // The stuck engine may still write, so another tab must not become a second writer.
    const other = createBrowserDeviceService(rig(disk, { lockWaitMs: 20 }).deps);
    expect(await other.ensureReady(alice)).toEqual({ kind: 'unavailable', retryable: true });
  });
});
