import { describe, expect, test, vi } from 'vitest';
import type {
  AdmissionPort, Admission, AuthPrincipal, DeviceId, DevicePort, DeviceView, IdentityPort, IdentityState, InviteState, OwnerId, RoomId,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/index';
import { createJoinController } from './controller';
import type { JoinPorts } from './ports';
import { parseJoinLocation } from './location';
import type { JoinView } from './model';

const principal: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_1' as OwnerId,
  providerIssuer: 'https://issuer.example',
  providerSubject: 'sub_1',
  verifiedEmail: 'person@example.com',
  sessionExpiresAt: '2026-01-01T00:00:00Z',
};

const readyDevice: DeviceView = { deviceId: 'device_1' as DeviceId, state: 'ready', generation: 1, reason: null };
const room = { roomId: 'room_1' as RoomId, title: null, membership: 'joined' as const, revision: 'rev_1' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function makePorts(overrides: Partial<JoinPorts> = {}): JoinPorts {
  const identity: IdentityPort = {
    current: async () => ({ kind: 'signed_in', principal }),
    beginSignIn: async () => ok({ kind: 'navigate', url: 'https://issuer.example/authorize' }),
    signOut: async () => ok(null),
  };
  const device: DevicePort = {
    ensureReady: async () => ok(readyDevice),
    current: () => readyDevice,
    observe: () => () => {},
    stop: async () => {},
  };
  const admission: AdmissionPort = {
    share: async () => unavailable(),
    inspect: async () => 'eligible',
    admit: async () => ok({ outcome: 'joined', room }),
  };
  return { identity, device, admission, codec: { parseJoinLocation }, navigate: () => {}, ...overrides };
}

function record(controller: ReturnType<typeof createJoinController>): JoinView[] {
  const views: JoinView[] = [];
  controller.subscribe(view => views.push(view));
  return views;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createJoinController happy path', () => {
  test('signed-in, eligible, ready device reaches joined with the room id', async () => {
    const controller = createJoinController(makePorts());
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toEqual({ phase: 'joined', email: 'person@example.com', roomId: 'room_1', retryAllowed: false, errorCode: null });
    expect(views.map(v => v.phase)).toEqual(['checking_identity', 'checking_invitation', 'initializing_device', 'joining', 'joined']);
  });
});

describe('createJoinController invalid location', () => {
  test('a malformed locator yields a safe unavailable state without touching any port', async () => {
    const identity = vi.fn();
    const controller = createJoinController(makePorts({ identity: { current: identity, beginSignIn: identity, signOut: identity } as unknown as IdentityPort }));
    const views = record(controller);
    controller.start(`not a url ${String.fromCharCode(0)}`);
    await flush();
    expect(views.at(-1)).toEqual({ phase: 'unavailable', email: null, roomId: null, retryAllowed: false, errorCode: 'invalid_location' });
    expect(identity).not.toHaveBeenCalled();
  });
});

describe('createJoinController signed out', () => {
  test('shows sign_in without navigating automatically', async () => {
    const navigate = vi.fn();
    const identity: IdentityPort = {
      current: async () => ({ kind: 'signed_out' }),
      beginSignIn: async () => ok({ kind: 'navigate', url: 'https://issuer.example/authorize' }),
      signOut: async () => ok(null),
    };
    const controller = createJoinController(makePorts({ identity, navigate }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)?.phase).toBe('sign_in');
    expect(navigate).not.toHaveBeenCalled();
  });

  test('signIn() navigates using the identity intent, keyed to the same invite reference', async () => {
    const navigate = vi.fn();
    const identity: IdentityPort = {
      current: async () => ({ kind: 'signed_out' }),
      beginSignIn: vi.fn(async () => ok({ kind: 'navigate' as const, url: 'https://issuer.example/authorize?x=1' })),
      signOut: async () => ok(null),
    };
    const controller = createJoinController(makePorts({ identity, navigate }));
    controller.start('/join?invite=abc');
    await flush();
    await controller.signIn();
    expect(navigate).toHaveBeenCalledWith('https://issuer.example/authorize?x=1');
    expect(identity.beginSignIn).toHaveBeenCalledWith('/join?invite=abc');
  });
});

describe('createJoinController identity unavailable', () => {
  test('is distinct from signed out and allows retry without forcing logout', async () => {
    const identity: IdentityPort = {
      current: async () => ({ kind: 'unavailable', retryable: true } satisfies IdentityState),
      beginSignIn: async () => ok({ kind: 'navigate', url: 'https://issuer.example/authorize' }),
      signOut: async () => ok(null),
    };
    const controller = createJoinController(makePorts({ identity }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toEqual({ phase: 'unavailable', email: null, roomId: null, retryAllowed: true, errorCode: 'identity_unavailable' });
  });
});

describe('createJoinController invitation states', () => {
  test.each([
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['identity_mismatch', 'wrong_account'],
    ['auth_required', 'sign_in'],
  ] as const)('inspect() %s maps to phase %s without touching device or admission.admit', async (state, phase) => {
    const admit = vi.fn();
    const ensureReady = vi.fn();
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => state, admit },
      device: { ensureReady, current: () => readyDevice, observe: () => () => {}, stop: async () => {} },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)?.phase).toBe(phase);
    expect(views.at(-1)?.roomId).toBeNull();
    expect(admit).not.toHaveBeenCalled();
    expect(ensureReady).not.toHaveBeenCalled();
  });

  test('an unavailable invitation check allows retry', async () => {
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'unavailable', admit: vi.fn() },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true });
  });
});

describe('createJoinController — AE1: revocation during OAuth', () => {
  test('a revoked admit result shows revoked, never room content', async () => {
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit: async () => rejected('revoked') },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    const last = views.at(-1)!;
    expect(last.phase).toBe('revoked');
    expect(last.roomId).toBeNull();
  });

  test('admit() rejected with auth_required shows sign_in, not revoked', async () => {
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit: async () => rejected('auth_required') },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)?.phase).toBe('sign_in');
  });

  test('admit() rejected with forbidden shows a neutral, non-retryable denial, never wrong_account', async () => {
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit: async () => rejected('forbidden') },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: false, errorCode: 'admission_denied' });
  });
});

describe('createJoinController device retry', () => {
  test('device init fails then succeeds on explicit retry; admit runs exactly once', async () => {
    let attempt = 0;
    const ensureReady = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? ok({ deviceId: null, state: 'failed', generation: 1, reason: 'initialization_failed' } satisfies DeviceView)
        : ok(readyDevice);
    });
    const admit = vi.fn(async () => ok({ outcome: 'joined' as const, room }));
    const controller = createJoinController(makePorts({
      device: { ensureReady, current: () => readyDevice, observe: () => () => {}, stop: async () => {} },
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true, errorCode: 'initialization_failed' });

    controller.retry();
    await flush();
    expect(views.at(-1)?.phase).toBe('joined');
    expect(admit).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledTimes(2);
  });
});

describe('createJoinController device rejection', () => {
  test('owner_mismatch maps to wrong_account, not unavailable', async () => {
    const controller = createJoinController(makePorts({
      device: { ensureReady: async () => rejected('owner_mismatch'), current: () => readyDevice, observe: () => () => {}, stop: async () => {} },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'wrong_account', retryAllowed: false });
  });
});

describe('createJoinController retry flags', () => {
  test('a device port outcome_unknown is retryable', async () => {
    const controller = createJoinController(makePorts({
      device: { ensureReady: async () => outcomeUnknown('op_1'), current: () => readyDevice, observe: () => () => {}, stop: async () => {} },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true, errorCode: 'device_unavailable' });
  });

  test('a device port unavailable result is retryable', async () => {
    const controller = createJoinController(makePorts({
      device: { ensureReady: async () => unavailable(), current: () => readyDevice, observe: () => () => {}, stop: async () => {} },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true, errorCode: 'device_unavailable' });
  });

  test('an admission port unavailable result (as opposed to a rejection) is retryable', async () => {
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit: async () => unavailable() },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true, errorCode: 'admission_unavailable' });
  });
});

describe('createJoinController signIn rejection', () => {
  test('a rejected beginSignIn result surfaces invalid_return_path, not a silent no-op', async () => {
    const identity: IdentityPort = {
      current: async () => ({ kind: 'signed_out' }),
      beginSignIn: async () => rejected('invalid_return_path'),
      signOut: async () => ok(null),
    };
    const navigate = vi.fn();
    const controller = createJoinController(makePorts({ identity, navigate }));
    controller.start('/join?invite=abc');
    await flush();
    await controller.signIn();
    expect(navigate).not.toHaveBeenCalled();
    expect(controller.getView()).toMatchObject({ phase: 'unavailable', errorCode: 'invalid_return_path' });
  });
});

describe('createJoinController stale-response fences', () => {
  test('a stale inspect() response is discarded by a newer start()', async () => {
    const first = deferred<InviteState>();
    let calls = 0;
    const admit = vi.fn();
    const controller = createJoinController(makePorts({
      admission: {
        share: async () => unavailable(),
        inspect: () => { calls += 1; return calls === 1 ? first.promise : Promise.resolve('unavailable' as const); },
        admit,
      },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush(); // first call reaches checking_invitation; its inspect() is pending on `first`
    expect(calls).toBe(1);
    controller.start('/join?invite=abc');
    await flush(); // the second call's own inspect() resolves 'unavailable'
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', errorCode: 'invitation_unavailable' });

    first.resolve('eligible');
    await flush();
    expect(admit).not.toHaveBeenCalled();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', errorCode: 'invitation_unavailable' });
  });

  test('a stale ensureReady() response is discarded by a newer start()', async () => {
    const first = deferred<Awaited<ReturnType<DevicePort['ensureReady']>>>();
    let calls = 0;
    const admit = vi.fn();
    const controller = createJoinController(makePorts({
      device: {
        ensureReady: () => { calls += 1; return calls === 1 ? first.promise : Promise.resolve(unavailable()); },
        current: () => readyDevice,
        observe: () => () => {},
        stop: async () => {},
      },
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush(); // first call reaches initializing_device; its ensureReady() is pending on `first`
    expect(calls).toBe(1);
    controller.start('/join?invite=abc');
    await flush(); // the second call's own ensureReady() resolves unavailable
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', errorCode: 'device_unavailable' });

    first.resolve(ok(readyDevice));
    await flush();
    expect(admit).not.toHaveBeenCalled();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', errorCode: 'device_unavailable' });
  });

  test('a stale admit() response is discarded by a newer start()', async () => {
    const first = deferred<Awaited<ReturnType<AdmissionPort['admit']>>>();
    let calls = 0;
    const admit = vi.fn((): Promise<Awaited<ReturnType<AdmissionPort['admit']>>> => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve(unavailable());
    });
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush(); // first call reaches joining; its admit() is pending on `first`
    expect(calls).toBe(1);
    controller.start('/join?invite=abc');
    await flush(); // the second call's own admit() resolves unavailable
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', errorCode: 'admission_unavailable' });

    first.resolve(ok<Admission>({ outcome: 'joined', room }));
    await flush();
    expect(views.some(v => v.phase === 'joined')).toBe(false);
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', errorCode: 'admission_unavailable' });
  });
});

describe('createJoinController operation id lifecycle', () => {
  test('a completed ok clears the operation id so retry() after re-joining claims a fresh one', async () => {
    // Uses retry(), not start(): start() always resets operationId itself, so
    // only retry() isolates whether admit()'s own 'ok' branch clears it.
    const seenOperationIds: string[] = [];
    const admit = vi.fn(async (input: Parameters<AdmissionPort['admit']>[0]) => {
      seenOperationIds.push(input.operationId);
      return ok<Admission>({ outcome: 'joined', room });
    });
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    controller.start('/join?invite=abc');
    await flush();
    controller.retry();
    await flush();
    expect(admit).toHaveBeenCalledTimes(2);
    expect(seenOperationIds[0]).not.toBe(seenOperationIds[1]);
  });

  test('start() discards a stale in-flight operation id rather than reusing it', async () => {
    const seenOperationIds: string[] = [];
    const admitDeferred = deferred<Awaited<ReturnType<AdmissionPort['admit']>>>();
    let calls = 0;
    const admit = vi.fn((input: Parameters<AdmissionPort['admit']>[0]) => {
      seenOperationIds.push(input.operationId);
      calls += 1;
      return calls === 1 ? admitDeferred.promise : Promise.resolve(ok<Admission>({ outcome: 'joined', room }));
    });
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    controller.start('/join?invite=abc');
    await flush();
    controller.start('/join?invite=abc');
    await flush();
    expect(admit).toHaveBeenCalledTimes(2);
    expect(seenOperationIds[0]).not.toBe(seenOperationIds[1]);
  });
});

describe('createJoinController account switch', () => {
  test('a second start() discards a stale in-flight response and clears the protected view', async () => {
    const first = deferred<IdentityState>();
    let calls = 0;
    const identity: IdentityPort = {
      current: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve({ kind: 'signed_out' });
      },
      beginSignIn: async () => ok({ kind: 'navigate', url: 'https://issuer.example/authorize' }),
      signOut: async () => ok(null),
    };
    const controller = createJoinController(makePorts({ identity }));
    const views = record(controller);

    controller.start('/join?invite=abc');
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)?.phase).toBe('sign_in');

    first.resolve({ kind: 'signed_in', principal });
    await flush();
    // The stale first-generation response never overwrote the newer sign_in view.
    expect(views.at(-1)?.phase).toBe('sign_in');
    expect(views.some(v => v.phase === 'joined')).toBe(false);
  });
});

describe('createJoinController — unknown admit result', () => {
  test('outcome_unknown keeps the same operation id and a retry resolves the same attempt, never a second claim', async () => {
    const seenOperationIds: string[] = [];
    let attempt = 0;
    const admit = vi.fn(async (input: Parameters<AdmissionPort['admit']>[0]) => {
      seenOperationIds.push(input.operationId);
      attempt += 1;
      return attempt === 1 ? outcomeUnknown(input.operationId) : ok({ outcome: 'joined' as const, room });
    });
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true, errorCode: 'admission_unknown' });

    controller.retry();
    await flush();
    expect(views.at(-1)?.phase).toBe('joined');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(seenOperationIds[0]).toBe(seenOperationIds[1]);
  });
});

describe('createJoinController already_joined', () => {
  test('resolves to the existing room without a distinct phase', async () => {
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'already_joined', admit: async () => ok({ outcome: 'already_joined', room }) },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toEqual({ phase: 'joined', email: 'person@example.com', roomId: 'room_1', retryAllowed: false, errorCode: null });
  });
});

describe('createJoinController admission operation_mismatch', () => {
  test('is retryable with a fresh operation id, not a dead end', async () => {
    const seenOperationIds: string[] = [];
    let attempt = 0;
    const admit = vi.fn(async (input: Parameters<AdmissionPort['admit']>[0]) => {
      seenOperationIds.push(input.operationId);
      attempt += 1;
      return attempt === 1 ? rejected('operation_mismatch') : ok({ outcome: 'joined' as const, room });
    });
    const controller = createJoinController(makePorts({
      admission: { share: async () => unavailable(), inspect: async () => 'eligible', admit },
    }));
    const views = record(controller);
    controller.start('/join?invite=abc');
    await flush();
    expect(views.at(-1)).toMatchObject({ phase: 'unavailable', retryAllowed: true, errorCode: 'admission_rejected' });

    controller.retry();
    await flush();
    expect(views.at(-1)?.phase).toBe('joined');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(seenOperationIds[0]).not.toBe(seenOperationIds[1]);
  });
});
