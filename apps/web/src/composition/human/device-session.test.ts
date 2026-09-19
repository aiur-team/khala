import { describe, expect, it, vi } from 'vitest';
import {
  ok,
  type AuthPrincipal,
  type DevicePort,
  type DeviceView,
  type OwnerId,
} from '@khala/contracts/messaging/index';
import { createHumanDeviceSession } from './device-session';

const alice: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_alice' as OwnerId,
  providerIssuer: 'https://issuer.example',
  providerSubject: 'alice',
  verifiedEmail: 'alice@example.test',
  sessionExpiresAt: '2030-01-01T00:00:00Z',
};

const ready: DeviceView = {
  deviceId: 'device_alice' as DeviceView['deviceId'],
  state: 'ready',
  generation: 1,
  reason: null,
};

function fakeDevice() {
  let current = ready;
  let listener: (view: DeviceView) => void = () => undefined;
  const ensureReady = vi.fn(async () => ok(ready));
  const stop = vi.fn(async () => undefined);
  const port: DevicePort = {
    ensureReady,
    current: () => current,
    observe(next) {
      listener = next;
      return () => { listener = () => undefined; };
    },
    stop,
  };
  return { port, ensureReady, stop, emit: (view: DeviceView) => { current = view; listener(view); } };
}

describe('createHumanDeviceSession', () => {
  it('reuses one ready activation for the same provider identity', async () => {
    const device = fakeDevice();
    const session = createHumanDeviceSession(device.port);

    expect(await session.ensureReady(alice)).toEqual(ok(ready));
    expect(await session.ensureReady(alice)).toEqual(ok(ready));
    expect(device.ensureReady).toHaveBeenCalledOnce();
  });

  it('retains a newer revocation observed after activation', async () => {
    const device = fakeDevice();
    const session = createHumanDeviceSession(device.port);
    await session.ensureReady(alice);
    const revoked: DeviceView = {
      deviceId: ready.deviceId,
      state: 'revoked',
      generation: 2,
      reason: 'revoked_by_owner',
    };

    device.emit(revoked);

    expect(session.current()).toEqual(revoked);
  });

  it('does not overwrite a revocation that arrived before ensureReady settled', async () => {
    const device = fakeDevice();
    let settle!: (value: ReturnType<typeof ok<DeviceView>>) => void;
    device.ensureReady.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const session = createHumanDeviceSession(device.port);
    const activation = session.ensureReady(alice);
    const revoked: DeviceView = {
      deviceId: ready.deviceId,
      state: 'revoked',
      generation: 2,
      reason: 'revoked_by_owner',
    };
    device.emit(revoked);
    settle(ok(ready));

    expect(await activation).toEqual({ kind: 'unavailable', retryable: true });
    expect(session.current()).toEqual(revoked);
  });

  it('stops the held device exactly once when released repeatedly', async () => {
    const device = fakeDevice();
    const session = createHumanDeviceSession(device.port);
    await session.ensureReady(alice);

    await session.release();
    await session.release();

    expect(device.stop).toHaveBeenCalledOnce();
    expect(session.current()).toBeNull();
  });
});
