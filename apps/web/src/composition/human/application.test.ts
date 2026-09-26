import { describe, expect, it, vi } from 'vitest';
import type {
  AdmissionPort,
  AuthPrincipal,
  ContentLimits,
  DevicePort,
  DeviceView,
  IdentityPort,
  IdentityState,
  OwnerId,
  RoomPort,
} from '@khala/contracts/messaging/index';
import { ok, unavailable } from '@khala/contracts/messaging/index';
import { createHumanApplication, type HumanApplicationSnapshot, type HumanRouteContext } from './application';

const limits = {
  maxBodyBytes: 4_096,
  maxDisplayNameBytes: 128,
  maxRoomTitleBytes: 256,
} as ContentLimits;

const alice = principal('owner_alice', 'alice');
const bob = principal('owner_bob', 'bob');

function principal(ownerId: string, subject: string): AuthPrincipal {
  return {
    v: 1,
    ownerId: ownerId as OwnerId,
    providerIssuer: 'https://issuer.example',
    providerSubject: subject,
    verifiedEmail: `${subject}@example.test`,
    sessionExpiresAt: '2030-01-01T00:00:00Z',
  };
}

function readyDevice(owner: AuthPrincipal, generation = 1): DeviceView {
  return { deviceId: `device_${owner.providerSubject}` as DeviceView['deviceId'], state: 'ready', generation, reason: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeDevice(overrides: Partial<DevicePort> = {}): DevicePort {
  let current: DeviceView = { deviceId: null, state: 'new', generation: 0, reason: null };
  return {
    async ensureReady(ownerId) {
      current = readyDevice(ownerId === alice.ownerId ? alice : bob);
      return ok(current);
    },
    current: () => current,
    observe: () => () => undefined,
    stop: async () => undefined,
    ...overrides,
  };
}

function application(
  identity: IdentityPort,
  device: DevicePort,
  createRouteDisposer?: (context: HumanRouteContext) => () => void,
) {
  return createHumanApplication(
    {
      identity,
      device,
      room: {} as RoomPort,
      admission: {} as AdmissionPort,
      limits,
    },
    { initialPath: '/channels/first', ...(createRouteDisposer ? { createRouteDisposer } : {}) },
  );
}

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion);
}

function ready(snapshot: HumanApplicationSnapshot): HumanRouteContext {
  expect(snapshot.phase).toBe('ready');
  if (snapshot.phase !== 'ready') throw new Error(`expected ready, received ${snapshot.phase}`);
  return snapshot.context;
}


/** Lets a stale continuation run all the way (not one microtask) so a missing
 * generation fence actually shows up as a wrong snapshot. */
function settleStaleContinuations(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}

describe('createHumanApplication', () => {
  it('fences a stale identity response after navigation activates another account', async () => {
    const firstIdentity = deferred<IdentityState>();
    const identity: IdentityPort = {
      current: vi.fn()
        .mockImplementationOnce(() => firstIdentity.promise)
        .mockResolvedValue({ kind: 'signed_in', principal: bob }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const ensureReady = vi.fn(async (ownerId: OwnerId) => ok(readyDevice(ownerId === alice.ownerId ? alice : bob)));
    const app = application(identity, fakeDevice({ ensureReady }));

    app.navigate('/channels/bob');
    await eventually(() => expect(app.getSnapshot().phase).toBe('ready'));
    expect(ready(app.getSnapshot()).principal.ownerId).toBe(bob.ownerId);

    firstIdentity.resolve({ kind: 'signed_in', principal: alice });
    await settleStaleContinuations();

    expect(ready(app.getSnapshot()).principal.ownerId).toBe(bob.ownerId);
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith(bob.ownerId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shares one in-flight device activation across repeated navigation for the same owner', async () => {
    const deviceResult = deferred<Awaited<ReturnType<DevicePort['ensureReady']>>>();
    const ensureReady = vi.fn(() => deviceResult.promise);
    const identity: IdentityPort = {
      current: vi.fn().mockResolvedValue({ kind: 'signed_in', principal: alice }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const app = application(identity, fakeDevice({ ensureReady }));

    await eventually(() => expect(ensureReady).toHaveBeenCalledTimes(1));
    app.navigate('/channels/second');
    await eventually(() => expect(identity.current).toHaveBeenCalledTimes(2));
    expect(ensureReady).toHaveBeenCalledTimes(1);

    deviceResult.resolve(ok(readyDevice(alice)));
    await eventually(() => expect(app.getSnapshot().phase).toBe('ready'));

    expect(ready(app.getSnapshot()).path).toBe('/channels/second');
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });

  it('deactivates the old route before stopping its device on account switch', async () => {
    const events: string[] = [];
    const identity: IdentityPort = {
      current: vi.fn()
        .mockResolvedValueOnce({ kind: 'signed_in', principal: alice })
        .mockResolvedValueOnce({ kind: 'signed_in', principal: bob }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const device = fakeDevice({
      ensureReady: vi.fn(async ownerId => {
        events.push(`ensure:${ownerId}`);
        return ok(readyDevice(ownerId === alice.ownerId ? alice : bob));
      }),
      stop: vi.fn(async () => { events.push('stop'); }),
    });
    const app = application(identity, device, context => {
      events.push(`activate:${context.principal.ownerId}`);
      return () => { events.push(`dispose:${context.principal.ownerId}`); };
    });
    await eventually(() => expect(app.getSnapshot().phase).toBe('ready'));

    app.navigate('/channels/bob');
    await eventually(() => expect(ready(app.getSnapshot()).principal.ownerId).toBe(bob.ownerId));

    expect(events).toEqual([
      `ensure:${alice.ownerId}`,
      `activate:${alice.ownerId}`,
      `dispose:${alice.ownerId}`,
      'stop',
      `ensure:${bob.ownerId}`,
      `activate:${bob.ownerId}`,
    ]);
  });

  it('keeps a stale device initialization fenced after logout', async () => {
    const deviceResult = deferred<Awaited<ReturnType<DevicePort['ensureReady']>>>();
    const identity: IdentityPort = {
      current: vi.fn()
        .mockResolvedValueOnce({ kind: 'signed_in', principal: alice })
        .mockResolvedValueOnce({ kind: 'signed_out' }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const stop = vi.fn(async () => undefined);
    const app = application(identity, fakeDevice({ ensureReady: vi.fn(() => deviceResult.promise), stop }));
    await eventually(() => expect(app.getSnapshot().phase).toBe('initializing_device'));

    app.navigate('/signed-out');
    await eventually(() => expect(app.getSnapshot().phase).toBe('signed_out'));
    deviceResult.resolve(ok(readyDevice(alice)));
    await settleStaleContinuations();

    expect(app.getSnapshot()).toMatchObject({ phase: 'signed_out', context: null });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('keeps identity unavailability distinct from an authenticated signed-out state', async () => {
    const identity: IdentityPort = {
      current: vi.fn()
        .mockResolvedValueOnce({ kind: 'unavailable', retryable: true })
        .mockResolvedValueOnce({ kind: 'signed_out' }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const app = application(identity, fakeDevice());

    await eventually(() => expect(app.getSnapshot().phase).toBe('unavailable'));
    expect(app.getSnapshot()).toMatchObject({ phase: 'unavailable', source: 'identity' });

    app.navigate('/signed-out');
    await eventually(() => expect(app.getSnapshot().phase).toBe('signed_out'));
    expect(app.getSnapshot()).toMatchObject({ phase: 'signed_out', context: null });
  });

  it('reports device failures without exposing a protected route context', async () => {
    const identity: IdentityPort = {
      current: vi.fn().mockResolvedValue({ kind: 'signed_in', principal: alice }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const app = application(identity, fakeDevice({ ensureReady: vi.fn(async () => unavailable()) }));

    await eventually(() => expect(app.getSnapshot().phase).toBe('unavailable'));

    expect(app.getSnapshot()).toMatchObject({ phase: 'unavailable', source: 'device', context: null });
  });

  it('does not publish ready when revocation follows activation before rendering', async () => {
    let notify: (view: DeviceView) => void = () => undefined;
    const identity: IdentityPort = {
      current: vi.fn().mockResolvedValue({ kind: 'signed_in', principal: alice }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const ensureResult = deferred<Awaited<ReturnType<DevicePort['ensureReady']>>>();
    const device = fakeDevice({
      ensureReady: vi.fn(() => ensureResult.promise),
      observe(listener) {
        notify = listener;
        return () => undefined;
      },
    });
    const app = application(identity, device);
    await eventually(() => expect(app.getSnapshot().phase).toBe('initializing_device'));

    ensureResult.resolve(ok(readyDevice(alice)));
    await Promise.resolve();
    notify({
      deviceId: readyDevice(alice).deviceId,
      state: 'revoked',
      generation: 2,
      reason: 'revoked_by_owner',
    });

    await eventually(() => expect(app.getSnapshot().phase).toBe('unavailable'));
    expect(app.getSnapshot()).toMatchObject({ source: 'device', reason: 'revoked_by_owner', retryable: false });
  });

  it('clears the active context synchronously and contains a rejected device stop on dispose', async () => {
    const identity: IdentityPort = {
      current: vi.fn().mockResolvedValue({ kind: 'signed_in', principal: alice }),
      beginSignIn: vi.fn(),
      signOut: vi.fn(),
    };
    const routeDisposer = vi.fn();
    const stop = vi.fn(async () => { throw new Error('shutdown failed'); });
    const app = application(identity, fakeDevice({ stop }), () => routeDisposer);
    await eventually(() => expect(app.getSnapshot().phase).toBe('ready'));

    app.dispose();

    expect(app.getSnapshot()).toMatchObject({ phase: 'disposed', context: null });
    expect(routeDisposer).toHaveBeenCalledOnce();
    await eventually(() => expect(stop).toHaveBeenCalledOnce());
  });
});
