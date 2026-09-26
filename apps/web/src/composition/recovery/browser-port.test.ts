import {
  type AuthPrincipal, type BindingId, type DevicePort, type DeviceView, type IdentityPort, type IdentityState, type OwnerId,
  ok,
} from '@khala/contracts/messaging/index';
import { describe, expect, it, vi } from 'vitest';
import type { HumanRouteContext } from '../human/application';
import { type BrowserRevocation, createBrowserRecoveryPort } from './browser-port';
import { projectRecovery } from './projection';
import { registerRecovery } from './register';

const SECRET_CANARY = 'canary-recovery-secret-7f3a';
const principal: AuthPrincipal = {
  v: 1, ownerId: 'owner_b' as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: 'sub-owner-b',
  verifiedEmail: 'owner-b@example.test', sessionExpiresAt: '2026-09-18T20:00:00Z',
};

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
  it('shows a signed-in device as partial history with recovery refused under P14', async () => {
    const device = fakeDevice(ready);
    const ports = createBrowserRecoveryPort({ principal, identity: identity(), device: device.port });
    await settled();

    expect(ports.ui.snapshot()).toMatchObject({
      identity: { kind: 'signed_in' },
      device: ready,
      history: 'partial',
      recovery: { modes: [], unavailableReason: 'unsupported_substrate' },
      revocationTargets: [],
      closure: null,
    });
    const provideSecret = vi.fn(async () => new TextEncoder().encode(SECRET_CANARY));
    expect(await ports.ui.beginRecovery({ operationId: 'recover-b-1', mode: 'backup' }, provideSecret))
      .toEqual({ kind: 'rejected', code: 'unsupported_mode' });
    expect(provideSecret).not.toHaveBeenCalled();
  });

  it('keeps a device without keys unavailable, and a signed-out owner without targets', async () => {
    const device = fakeDevice({ ...ready, state: 'locked', reason: 'key_material_missing' });
    const revocation = { targets: () => [{ targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 }] } as unknown as BrowserRevocation;
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
      operationId: 'revoke-b-2', operation: 'revocation', deviceState: 'ready', history: 'partial',
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
      targets: () => [{ targetKind: 'binding', targetId: 'bnd_1' as BindingId, expectedGeneration: 3 }],
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
