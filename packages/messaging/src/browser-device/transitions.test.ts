import { describe, expect, it } from 'vitest';
import type { DeviceView } from '@khala/contracts/messaging/index';
import { createDisk, device, owner, rig, session } from './fakes';
import { createBrowserDeviceService } from './service';

const alice = owner('owner_alice');
const bob = owner('owner_bob');

describe('account switch', () => {
  it('drops a late decryption callback from the old account (AE2)', async () => {
    const disk = createDisk();
    const tab = rig(disk, { credentials: { owner_alice: session('DEVICE_A'), owner_bob: session('DEVICE_B') } });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    // Alice's timeline projection, fed by an SDK decryption callback.
    const projection: string[] = [];
    let lateDecrypted!: (body: string) => void;
    await service.use(alice, async context => {
      lateDecrypted = context.guard((body: string) => projection.push(body));
      context.onEnd(() => projection.splice(0));
      lateDecrypted('alice: before switch');
    });
    const aliceEngine = tab.engines[0]!;
    expect(projection).toEqual(['alice: before switch']);

    tab.identity.signIn('owner_bob');
    const result = await service.ensureReady(bob);
    lateDecrypted('alice: late plaintext');
    aliceEngine.input.emit('revoked');

    expect(result).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_B', state: 'ready', generation: 2, reason: null } });
    expect(projection).toEqual([]);
    expect(service.current().state).toBe('ready');
    // The old client and store closed before the new owner's store opened.
    expect(tab.log).toEqual([
      'store:owner_alice', 'open:owner_alice', 'start:owner_alice',
      'close:owner_alice', 'store-close:owner_alice',
      'store:owner_bob', 'open:owner_bob', 'start:owner_bob',
    ]);
  });

  it('abandons an in-flight initialisation for the previous account', async () => {
    let releaseAlice!: () => void;
    const tab = rig(createDisk(), {
      credentials: {
        owner_alice: () => new Promise(resolve => { releaseAlice = () => resolve(session('DEVICE_A')); }),
        owner_bob: session('DEVICE_B'),
      },
    });
    const service = createBrowserDeviceService(tab.deps);

    const aliceInit = service.ensureReady(alice);
    await new Promise(resolve => setTimeout(resolve, 0));
    tab.identity.signIn('owner_bob');
    const bobInit = service.ensureReady(bob);
    releaseAlice();

    expect(await aliceInit).toEqual({ kind: 'unavailable', retryable: true });
    expect(await bobInit).toMatchObject({ kind: 'ok', value: { deviceId: 'DEVICE_B', state: 'ready' } });
    expect(tab.log.filter(entry => entry.includes('owner_alice'))).toEqual([]);
  });
});

describe('revocation', () => {
  it('prevents ready publication when revoked during initialisation', async () => {
    const tab = rig(createDisk(), { engine: { onStart: engine => engine.input.emit('revoked') } });
    const service = createBrowserDeviceService(tab.deps);
    const views: DeviceView[] = [];
    service.observe(view => views.push(view));

    const result = await service.ensureReady(alice);

    expect(result).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'revoked', generation: 2, reason: 'revoked_by_owner' } });
    expect(views.map(view => view.state)).toEqual(['initializing', 'revoked']);
    expect(tab.engines[0]?.closed).toBe(true);
    // Revocation is terminal for this device: retrying opens nothing.
    expect(await service.ensureReady(alice)).toEqual(result);
    expect(tab.engines).toHaveLength(1);
  });

  it('reports a device the credential source says is revoked', async () => {
    const tab = rig(createDisk(), { credentials: { owner_alice: { kind: 'revoked', deviceId: device('DEVICE_A') } } });
    const service = createBrowserDeviceService(tab.deps);

    expect(await service.ensureReady(alice)).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'revoked', generation: 2, reason: 'revoked_by_owner' } });
    expect(tab.log).toEqual([]);
  });

  it('closes a ready device revoked by its owner and advances the generation', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);

    tab.engines[0]!.input.emit('revoked');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(service.current()).toEqual({ deviceId: 'DEVICE_A', state: 'revoked', generation: 2, reason: 'revoked_by_owner' });
    expect(tab.engines[0]?.closed).toBe(true);
  });
});

describe('expired sessions', () => {
  it('signals auth required without deleting key material', async () => {
    const disk = createDisk();
    let credentials = session('DEVICE_A');
    const tab = rig(disk, { credentials: { owner_alice: async () => credentials } });
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);
    const marker = disk.markers.get(alice);
    const keys = new Map(disk.stores);

    tab.engines[0]!.input.emit('session_expired');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.current()).toEqual({ deviceId: 'DEVICE_A', state: 'locked', generation: 1, reason: 'signed_out' });

    credentials = { kind: 'expired' };
    expect(await service.ensureReady(alice)).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'locked', generation: 2, reason: 'signed_out' } });
    expect(disk.markers.get(alice)).toEqual(marker);
    expect(disk.stores).toEqual(keys);

    credentials = session('DEVICE_A');
    const resumed = await service.ensureReady(alice);
    expect(resumed).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'ready', generation: 3, reason: null } });
    expect(await tab.engines.at(-1)?.identity()).toEqual({ fingerprint: marker?.fingerprint, created: false });
  });

  it('locks a ready device when the owner signs out, and stop drops its callbacks', async () => {
    const tab = rig(createDisk());
    const service = createBrowserDeviceService(tab.deps);
    await service.ensureReady(alice);
    const seen: string[] = [];
    let callback!: () => void;
    await service.use(alice, async context => { callback = context.guard(() => seen.push('late')); });

    tab.identity.set({ kind: 'signed_out' });
    expect(await service.ensureReady(alice)).toEqual({ kind: 'ok', value: { deviceId: 'DEVICE_A', state: 'locked', generation: 1, reason: 'signed_out' } });
    expect(tab.engines[0]?.closed).toBe(true);

    await service.stop();
    callback();
    expect(seen).toEqual([]);
    expect(service.current()).toEqual({ deviceId: null, state: 'new', generation: 2, reason: null });
  });
});
