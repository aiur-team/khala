import {
  CLOSURE_CONSEQUENCES, type AuthPrincipal, type BindingId, type DevicePort, type DeviceView, type IdentityPort, type IdentityState, type OwnerId,
  ok,
} from '@khala/contracts/messaging/index';
import { describe, expect, it, vi } from 'vitest';
import { createRecoveryController } from '../../features/recovery/controller';
import type { HumanRouteContext } from '../human/application';
import { type BrowserClosure, type BrowserRevocation, createBrowserRecoveryPort, memoryResumeStore, sessionResumeStore } from './browser-port';
import { projectRecovery } from './projection';
import { registerRecovery } from './register';

const SECRET_CANARY = 'canary-recovery-secret-7f3a';
const principal: AuthPrincipal = {
  v: 1, ownerId: 'owner_b' as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: 'sub-owner-b',
  verifiedEmail: 'owner-b@example.test', sessionExpiresAt: '2026-09-18T20:00:00Z',
};
const scopedTargets = (targets: readonly { targetKind: 'binding'; targetId: BindingId; expectedGeneration: number }[]) => ({
  ownerId: principal.ownerId, providerIssuer: principal.providerIssuer, providerSubject: principal.providerSubject, targets,
});

function fakeDevice(initial: DeviceView) {
  let view = initial;
  const listeners = new Set<(view: DeviceView) => void>();
  const port: DevicePort = {
    ensureReady: async () => ok(view),
    current: () => view,
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    port,
    listeners,
    emit(next: DeviceView) {
      view = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function identity(state: IdentityState = { kind: 'signed_in', principal }): IdentityPort {
  return {
    current: async () => state,
    beginSignIn: async () => ok({ kind: 'navigate', url: '/' }),
    signOut: async () => ok(null),
  };
}

const ready: DeviceView = { deviceId: 'KHALADEV1' as DeviceView['deviceId'], state: 'ready', generation: 1, reason: null };

async function settled() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('createBrowserRecoveryPort', () => {
  it('keeps only scoped operation identity across a tab reload and rejects an unavailable write-ahead store', () => {
    const rows = new Map<string, string>();
    const storage = { getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => { rows.set(key, value); },
      removeItem: (key: string) => { rows.delete(key); } };
    const roomId = '!room:example' as never;
    const reference = { kind: 'closure', operationId: 'close-pending', ownerId: principal.ownerId,
      deviceId: ready.deviceId, deviceGeneration: ready.generation, roomId, roomRevision: 0 } as const;
    const first = sessionResumeStore(principal.ownerId, roomId, storage);
    first.save({ ...reference, accidentalSecret: SECRET_CANARY } as never);
    expect(sessionResumeStore(principal.ownerId, roomId, storage).load()).toEqual(reference);
    expect(sessionResumeStore('other-owner' as OwnerId, roomId, storage).load()).toBeNull();
    expect([...rows.values()]).toEqual([JSON.stringify(reference)]);
    expect([...rows.values()].join('')).not.toContain(SECRET_CANARY);
    const broken = sessionResumeStore(principal.ownerId, roomId, { ...storage,
      setItem() { throw new Error('quota'); } });
    expect(() => broken.save(reference)).toThrow('quota');
    first.clear();
    expect(first.load()).toBeNull();
  });
  it('does not claim missing historical keys for a ready device without observed decrypt failures', async () => {
    const device = fakeDevice(ready);
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port });
    await settled();

    expect(ports.ui.snapshot()).toMatchObject({
      identity: { kind: 'signed_in' },
      device: ready,
      history: 'policy_limited',
      recovery: { modes: [], unavailableReason: 'unsupported_substrate' },
      revocationTargets: [],
      closure: null,
    });
    const provideSecret = vi.fn(async () => new TextEncoder().encode(SECRET_CANARY));
    expect(await ports.ui.beginRecovery({ operationId: 'recover-b-1', mode: 'backup' }, provideSecret))
      .toEqual({ kind: 'rejected', code: 'unsupported_mode' });
    expect(provideSecret).not.toHaveBeenCalled();
  });

  it('reports observed missing keys, clears them after decryption, and keeps other failures distinct', async () => {
    const device = fakeDevice(ready);
    let onEntries: ((view: { generation: number; entries: readonly { kind: 'unavailable'; reason: string }[] }) => void) | undefined;
    const stop = vi.fn();
    const roomId = 'room_1' as never;
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port,
      historyEntries: { roomId, observeEntries: (_roomId, listener) => {
        onEntries = listener as typeof onEntries;
        return stop;
      } },
    });
    expect(ports.ui.snapshot().history).toBe('policy_limited');
    onEntries?.({ generation: 1, entries: [{ kind: 'unavailable', reason: 'missing_key' }] });
    expect(ports.ui.snapshot().history).toBe('partial');
    onEntries?.({ generation: 1, entries: [{ kind: 'unavailable', reason: 'decryption_failed' }] });
    expect(ports.ui.snapshot().history).toBe('decrypt_failed');
    onEntries?.({ generation: 1, entries: [] });
    expect(ports.ui.snapshot().history).toBe('policy_limited');
    onEntries?.({ generation: 0, entries: [{ kind: 'unavailable', reason: 'missing_key' }] });
    expect(ports.ui.snapshot().history).toBe('policy_limited');
    device.emit({ ...ready, generation: 2, state: 'lost', reason: 'storage_cleared' });
    expect(ports.ui.snapshot().history).toBe('unavailable');
    device.emit({ ...ready, generation: 3 });
    expect(ports.ui.snapshot().history).toBe('policy_limited');
    ports.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('keeps a device without keys unavailable, and a signed-out owner without targets', async () => {
    const device = fakeDevice({ ...ready, state: 'locked', reason: 'key_material_missing' });
    const revocation = { targets: () => scopedTargets([{ targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 }]) } as unknown as BrowserRevocation;
    const ports = createBrowserRecoveryPort({ principal, identity: identity({ kind: 'signed_out' }), device: device.port, revocation });
    await settled();

    expect(ports.ui.snapshot()).toMatchObject({
      history: 'unavailable', recovery: { unavailableReason: 'signed_out' }, revocationTargets: [],
    });
  });

  it('never serialises a key, password, SDK token or principal into its observation', async () => {
    const device = fakeDevice(ready);
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port });
    await settled();
    const snapshot = { ...ports.ui.snapshot(), accessToken: SECRET_CANARY, recoveryKey: SECRET_CANARY } as never;
    const reference = {
      kind: 'revocation', operationId: 'revoke-b-2', ownerId: principal.ownerId, deviceId: null, deviceGeneration: 1,
      roomId: 'room_1', roomRevision: 7,
    } as const;

    const observation = projectRecovery(snapshot, reference as never);
    const text = JSON.stringify(observation);

    expect(observation).toEqual({
      operationId: 'revoke-b-2', operation: 'revocation', deviceState: 'ready', history: 'policy_limited',
      recoveryUnavailable: 'unsupported_substrate', allowedActions: [],
    });
    for (const forbidden of [SECRET_CANARY, principal.verifiedEmail, principal.providerSubject, 'owner_b']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('delegates revocation only when the control plane serves it, and never offers closure', async () => {
    const device = fakeDevice(ready);
    const bare = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port });
    const request = { operationId: 'revoke-1', targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 } as const;
    expect(await bare.ui.revoke(request)).toEqual({ kind: 'unavailable', retryable: true });

    const progress = { operationId: 'revoke-1', targetKind: 'binding', targetId: 'bnd_1', generation: 4, state: 'partial' } as const;
    const revocation: BrowserRevocation = {
      targets: () => scopedTargets([{ targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 }]),
      revoke: vi.fn(async () => ok(progress as never)),
      inspect: vi.fn(async () => ok(progress as never)),
    };
    const wired = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port, revocation });
    await settled();
    expect(wired.ui.snapshot().revocationTargets).toHaveLength(1);
    expect(projectRecovery(wired.ui.snapshot(), null).allowedActions).toEqual(['revoke']);
    expect(await wired.ui.revoke(request)).toEqual({ kind: 'ok', value: progress });
    expect(await wired.ui.inspectRevocation('revoke-1')).toEqual({ kind: 'ok', value: progress });
    expect(await wired.ui.closeRoom({ operationId: 'close-1', ownerId: principal.ownerId, roomId: 'room_1' as never, expectedRoomRevision: 1 }))
      .toEqual({ kind: 'unavailable', retryable: true });
  });

  it('offers only the current owner channel and delegates the typed closure identity', async () => {
    const device = fakeDevice(ready);
    const capability = {
      ownerId: principal.ownerId, roomId: 'room_1' as never, expectedRoomRevision: 0,
      available: true, unavailableReason: null, consequences: CLOSURE_CONSEQUENCES,
    } as const;
    const closure: BrowserClosure = {
      currentCapability: vi.fn(async () => capability),
      closeRoom: vi.fn(async input => ok({ operationId: input.operationId, state: 'partial' as const, reason: 'local_cleanup_failed' as const })),
      inspectClosure: vi.fn(async operationId => ok({ operationId, state: 'partial' as const, reason: 'local_cleanup_failed' as const })),
    };
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port, closure });
    await settled();
    expect(ports.ui.snapshot().closure).toEqual(capability);
    const command = { operationId: 'close_1', ownerId: principal.ownerId, roomId: capability.roomId, expectedRoomRevision: 0 };
    expect(await ports.ui.closeRoom(command)).toMatchObject({ kind: 'ok', value: { state: 'partial' } });
    expect(closure.closeRoom).toHaveBeenCalledWith(command, undefined);
    expect(await ports.ui.closeRoom({ ...command, roomId: 'room_2' as never })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await ports.ui.closeRoom({ ...command, expectedRoomRevision: 1 })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(closure.closeRoom).toHaveBeenCalledTimes(1);
    expect(await ports.ui.inspectClosure('close_1')).toMatchObject({ kind: 'ok', value: { state: 'partial' } });
  });

  it('fences stale owner actions and targets after an account switch', async () => {
    const device = fakeDevice(ready);
    let current: IdentityState = { kind: 'signed_in', principal };
    let identityUnavailable = false;
    const ownerIdentity: IdentityPort = { ...identity(), current: async () => {
      if (identityUnavailable) throw new Error('identity_unavailable');
      return current;
    } };
    const progress = { operationId: 'revoke-1', targetKind: 'binding', targetId: 'bnd_1', generation: 4, state: 'partial' } as const;
    const revocation: BrowserRevocation = {
      targets: () => scopedTargets([{ targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 }]),
      revoke: vi.fn(async () => ok(progress as never)),
      inspect: vi.fn(async () => ok(progress as never)),
    };
    const capability = { ownerId: principal.ownerId, roomId: 'room_1' as never, expectedRoomRevision: 0,
      available: true, unavailableReason: null, consequences: CLOSURE_CONSEQUENCES } as const;
    const closure: BrowserClosure = {
      currentCapability: vi.fn(async () => capability),
      closeRoom: vi.fn(async input => ok({ operationId: input.operationId, state: 'complete' as const, reason: null })),
      inspectClosure: vi.fn(async operationId => ok({ operationId, state: 'complete' as const, reason: null })),
    };
    const ports = createBrowserRecoveryPort({ principal, identity: ownerIdentity, device: device.port, revocation, closure });
    await settled();
    expect(ports.ui.snapshot().revocationTargets).toHaveLength(1);
    expect(ports.ui.snapshot().closure).toEqual(capability);

    // Even before a pending view refresh, an action must recheck the provider subject.
    current = { kind: 'signed_in', principal: { ...principal, providerSubject: 'other-subject' } };
    const revoke = { operationId: 'revoke-1', targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 } as const;
    const close = { operationId: 'close-1', ownerId: principal.ownerId, roomId: capability.roomId, expectedRoomRevision: 0 };
    expect(await ports.ui.revoke(revoke)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await ports.ui.inspectRevocation('revoke-1')).toEqual({ kind: 'rejected', code: 'not_found' });
    expect(await ports.ui.closeRoom(close)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await ports.ui.inspectClosure('close-1')).toEqual({ kind: 'rejected', code: 'not_found' });
    await ports.refresh();
    expect(ports.ui.snapshot().revocationTargets).toEqual([]);
    expect(ports.ui.snapshot().closure).toBeNull();

    current = { kind: 'signed_in', principal: { ...principal, ownerId: 'other-owner' as OwnerId } };
    await ports.refresh();
    expect(ports.ui.snapshot().revocationTargets).toEqual([]);
    expect(ports.ui.snapshot().closure).toBeNull();
    expect(await ports.ui.revoke(revoke)).toEqual({ kind: 'rejected', code: 'forbidden' });

    current = { kind: 'signed_in', principal };
    identityUnavailable = true;
    expect(await ports.ui.revoke(revoke)).toEqual({ kind: 'unavailable', retryable: true });
    expect(await ports.ui.inspectRevocation('revoke-1')).toEqual({ kind: 'outcome_unknown', operationId: 'revoke-1' });
    expect(await ports.ui.closeRoom(close)).toEqual({ kind: 'unavailable', retryable: true });
    expect(await ports.ui.inspectClosure('close-1')).toEqual({ kind: 'outcome_unknown', operationId: 'close-1' });
    expect(revocation.revoke).not.toHaveBeenCalled();
    expect(revocation.inspect).not.toHaveBeenCalled();
    expect(closure.closeRoom).not.toHaveBeenCalled();
    expect(closure.inspectClosure).not.toHaveBeenCalled();
  });

  it('does not publish mixed-owner targets when identity changes during lookup', async () => {
    const device = fakeDevice(ready);
    let current: IdentityState = { kind: 'signed_in', principal };
    const ownerIdentity: IdentityPort = { ...identity(), current: async () => current };
    let resolveTargets!: (targets: readonly { targetKind: 'binding'; targetId: BindingId; expectedGeneration: number }[]) => void;
    const targets = new Promise<readonly { targetKind: 'binding'; targetId: BindingId; expectedGeneration: number }[]>(resolve => {
      resolveTargets = resolve;
    });
    const revocation = { targets: () => targets.then(scopedTargets) } as unknown as BrowserRevocation;
    const ports = createBrowserRecoveryPort({ principal, identity: ownerIdentity, device: device.port, revocation });
    await settled();
    current = { kind: 'signed_in', principal: { ...principal, ownerId: 'other-owner' as OwnerId } };
    resolveTargets([{ targetKind: 'binding', targetId: 'other-binding' as BindingId, expectedGeneration: 4 }]);
    await settled();
    expect(ports.ui.snapshot().identity).toEqual(current);
    expect(ports.ui.snapshot().revocationTargets).toEqual([]);
  });

  it('rejects a target response bound to another owner even after an A-B-A identity switch', async () => {
    const device = fakeDevice(ready);
    const other = { ...principal, ownerId: 'other-owner' as OwnerId };
    let current: IdentityState = { kind: 'signed_in', principal };
    const ownerIdentity: IdentityPort = { ...identity(), current: async () => current };
    let resolveTargets!: (value: ReturnType<typeof scopedTargets>) => void;
    const targets = new Promise<ReturnType<typeof scopedTargets>>(resolve => { resolveTargets = resolve; });
    const revocation = { targets: () => targets } as unknown as BrowserRevocation;
    const ports = createBrowserRecoveryPort({ principal, identity: ownerIdentity, device: device.port, revocation });
    await settled();
    current = { kind: 'signed_in', principal: other };
    resolveTargets({ ...scopedTargets([{ targetKind: 'binding', targetId: 'other-binding' as BindingId,
      expectedGeneration: 4 }]), ownerId: other.ownerId });
    current = { kind: 'signed_in', principal };
    await settled();
    expect(ports.ui.snapshot().identity).toEqual(current);
    expect(ports.ui.snapshot().revocationTargets).toEqual([]);
  });

  it('keeps a pending operation reference when identity inspection is unavailable', async () => {
    const device = fakeDevice(ready);
    let identityUnavailable = false;
    const ownerIdentity: IdentityPort = { ...identity(), current: async () => {
      if (identityUnavailable) throw new Error('identity_unavailable');
      return { kind: 'signed_in', principal };
    } };
    const inspect = vi.fn(async () => ok({ operationId: 'revoke-pending', targetKind: 'binding' as const,
      targetId: 'bnd_1' as BindingId, generation: 4, state: 'complete' as const }));
    const revocation = { targets: () => scopedTargets([]), inspect } as unknown as BrowserRevocation;
    const ports = createBrowserRecoveryPort({ principal, identity: ownerIdentity, device: device.port, revocation });
    await settled();
    const roomId = 'room_1' as never;
    const reference = { kind: 'revocation', operationId: 'revoke-pending', ownerId: principal.ownerId,
      deviceId: ready.deviceId, deviceGeneration: ready.generation, roomId, roomRevision: 0 } as const;
    const resumeStore = memoryResumeStore();
    resumeStore.save(reference);
    identityUnavailable = true;
    const controller = createRecoveryController({ ui: ports.ui, resumeStore }, { roomId, roomRevision: 0 });
    await settled();
    expect(controller.getView().operation).toMatchObject({ kind: 'revocation', operationId: 'revoke-pending', state: 'outcome_unknown' });
    expect(resumeStore.load()).toEqual(reference);
    expect(inspect).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps owner identity and closure usable when optional revocation target lookup fails', async () => {
    const device = fakeDevice(ready);
    const capability = { ownerId: principal.ownerId, roomId: 'room_1' as never, expectedRoomRevision: 0,
      available: true, unavailableReason: null, consequences: CLOSURE_CONSEQUENCES } as const;
    const revocation = { targets: () => { throw new Error('control_unavailable'); } } as unknown as BrowserRevocation;
    const closure = { currentCapability: async () => capability } as unknown as BrowserClosure;
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port, revocation, closure });
    await ports.refresh();
    expect(ports.ui.snapshot()).toMatchObject({ identity: { kind: 'signed_in' }, revocationTargets: [], closure: capability });
  });

  it('ignores a device view from a replaced generation and publishes the current one', async () => {
    const device = fakeDevice(ready);
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port });
    const controller = new AbortController();
    const listener = vi.fn();
    ports.ui.subscribe(listener, controller.signal);

    device.emit({ ...ready, generation: 2, state: 'revoked', reason: 'revoked_by_owner' });
    expect(ports.ui.snapshot().device).toMatchObject({ generation: 2, state: 'revoked' });
    expect(ports.ui.snapshot().history).toBe('unavailable');
    expect(listener).toHaveBeenCalled();
  });

  it('disposes only its own observers and discards results that arrive afterwards', async () => {
    const device = fakeDevice(ready);
    let resolveIdentity!: (state: IdentityState) => void;
    const slow: IdentityPort = { ...identity(), current: () => new Promise(resolve => { resolveIdentity = resolve; }) };
    const ports = createBrowserRecoveryPort({ principal, identity: slow, device: device.port });
    const listener = vi.fn();
    ports.ui.subscribe(listener, new AbortController().signal);

    ports.dispose();
    resolveIdentity({ kind: 'signed_in', principal });
    await settled();

    expect(listener).not.toHaveBeenCalled();
    expect(ports.ui.snapshot().identity).toEqual({ kind: 'unavailable', retryable: true });
    expect(device.listeners.size).toBe(0);
    expect(device.port.stop).not.toHaveBeenCalled();
  });
});

describe('registerRecovery', () => {
  it('stays unavailable while the route has no recovery slot', () => {
    expect(registerRecovery()).toMatchObject({ id: 'recovery', state: 'unavailable' });
  });

  it('renders into a supplied slot and unmounts before closing its port', () => {
    const device = fakeDevice(ready);
    const calls: string[] = [];
    const capability = registerRecovery({
      render: (_context, ports) => {
        calls.push(`render:${ports.ui.snapshot().device.state}`);
        return () => calls.push('unmount');
      },
    });
    const context = { principal, identity: identity(), device: device.port } as unknown as HumanRouteContext;

    const handle = capability.attach(context);
    expect(capability.state).toBe('ready');
    handle.dispose();

    expect(calls).toEqual(['render:ready', 'unmount']);
    expect(device.listeners.size).toBe(0);
    expect(device.port.stop).not.toHaveBeenCalled();
  });
});
