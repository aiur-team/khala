import { describe, expect, it, vi } from 'vitest';
import type {
  BindingId,
  DeviceId,
  DeviceView,
  IdentityState,
  OwnerId,
  ProvideRecoverySecret,
  RoomId,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown } from '@khala/contracts/messaging/index';

import { createRecoveryController } from './controller';
import type {
  RecoveryOperationReference,
  RecoveryPorts,
  RecoverySnapshot,
  RecoveryUiPort,
  RevocationCapability,
} from './ports';

const OWNER_ID = 'owner-a' as OwnerId;
const OTHER_OWNER_ID = 'owner-b' as OwnerId;
const DEVICE_ID = 'device-a' as DeviceId;
const BINDING_ID = 'binding-a' as BindingId;
const ROOM_ID = 'room-a' as RoomId;

const SIGNED_IN: IdentityState = {
  kind: 'signed_in',
  principal: {
    v: 1,
    ownerId: OWNER_ID,
    providerIssuer: 'https://identity.example',
    providerSubject: 'subject-a',
    verifiedEmail: 'person@example.com',
    sessionExpiresAt: '2030-01-01T00:00:00Z',
  },
};

const DEVICE: DeviceView = {
  deviceId: DEVICE_ID,
  state: 'locked',
  generation: 4,
  reason: 'recovery_required',
};

const DEVICE_TARGET: RevocationCapability = {
  targetKind: 'device',
  targetId: DEVICE_ID,
  expectedGeneration: 4,
};

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    identity: SIGNED_IN,
    device: DEVICE,
    history: 'unavailable',
    connection: 'online',
    recovery: { modes: ['device_backup'], unavailableReason: null },
    revocationTargets: [
      DEVICE_TARGET,
      { targetKind: 'binding', targetId: BINDING_ID, expectedGeneration: 2 },
    ],
    closure: {
      ownerId: OWNER_ID,
      roomId: ROOM_ID,
      expectedRoomRevision: 7,
      available: true,
      unavailableReason: null,
      consequences: {
        stopsNewMessages: true,
        removesFromOwnerView: true,
        requestsLocalCleanup: true,
        recallsDeliveredCopies: false,
      },
    },
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function operationReference(kind: RecoveryOperationReference['kind'] = 'recovery'): RecoveryOperationReference {
  return {
    kind,
    operationId: `${kind}-saved`,
    ownerId: OWNER_ID,
    deviceId: DEVICE_ID,
    deviceGeneration: 4,
    roomId: ROOM_ID,
    roomRevision: 7,
  };
}

function fakePorts(options: Readonly<{
  initialSnapshot?: RecoverySnapshot;
  storedReference?: RecoveryOperationReference | null;
}> = {}) {
  let currentSnapshot = options.initialSnapshot ?? snapshot();
  let listener: (() => void) | null = null;
  let stored = options.storedReference ?? null;
  const order: string[] = [];

  const resumeStore = {
    load: vi.fn(() => stored),
    save: vi.fn((reference: RecoveryOperationReference) => {
      order.push(`save:${reference.operationId}`);
      stored = reference;
    }),
    clear: vi.fn(() => {
      stored = null;
    }),
  };

  const ui: RecoveryUiPort = {
    snapshot: vi.fn(() => currentSnapshot),
    subscribe: vi.fn((next, signal) => {
      listener = next;
      const dispose = () => { if (listener === next) listener = null; };
      signal.addEventListener('abort', dispose, { once: true });
      return dispose;
    }),
    beginRecovery: vi.fn(async (input, provideSecret) => {
      order.push(`begin:${input.operationId}`);
      await provideSecret({ operationId: input.operationId, mode: input.mode, attempt: 1 });
      return outcomeUnknown(input.operationId);
    }),
    inspectRecovery: vi.fn(async operationId => outcomeUnknown(operationId)),
    revoke: vi.fn(async input => {
      order.push(`revoke:${input.operationId}`);
      return outcomeUnknown(input.operationId);
    }),
    inspectRevocation: vi.fn(async operationId => outcomeUnknown(operationId)),
    closeRoom: vi.fn(async input => {
      order.push(`close:${input.operationId}`);
      return outcomeUnknown(input.operationId);
    }),
    inspectClosure: vi.fn(async operationId => outcomeUnknown(operationId)),
  };

  return {
    ports: { ui, resumeStore } satisfies RecoveryPorts,
    ui,
    resumeStore,
    order,
    stored: () => stored,
    emit(next: RecoverySnapshot) {
      currentSnapshot = next;
      listener?.();
    },
  };
}

describe('createRecoveryController', () => {
  it('refuses recovery under P14 without allocating identity or invoking the secret callback', async () => {
    const fake = fakePorts();
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'recovery-1',
    });
    const secret = new Uint8Array([115, 101, 99, 114, 101, 116]);
    const provideSecret: ProvideRecoverySecret = vi.fn(async () => secret);

    await expect(controller.beginRecovery('device_backup', provideSecret)).resolves.toBeNull();

    expect(fake.order).toEqual([]);
    expect(fake.ui.beginRecovery).not.toHaveBeenCalled();
    expect(provideSecret).not.toHaveBeenCalled();
    expect(fake.stored()).toBeNull();
    expect(controller.getView().operation).toEqual({ kind: 'idle' });
    expect(secret).toEqual(new Uint8Array([115, 101, 99, 114, 101, 116]));
  });

  it('hydrates a matching reference and inspects the same operation ID without replaying it', async () => {
    const reference = operationReference();
    const fake = fakePorts({ storedReference: reference });
    vi.mocked(fake.ui.inspectRecovery).mockResolvedValue(ok({
      operationId: reference.operationId,
      mode: 'device_backup',
      state: 'restored',
      reason: null,
    }));

    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'must-not-be-used',
    });
    await vi.waitFor(() => expect(controller.getView().operation).toMatchObject({ state: 'restored' }));

    expect(fake.ui.inspectRecovery).toHaveBeenCalledWith(
      reference.operationId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fake.ui.beginRecovery).not.toHaveBeenCalled();
    expect(fake.resumeStore.clear).toHaveBeenCalledOnce();

    await controller.beginRecovery('device_backup', async () => null);
    expect(fake.ui.beginRecovery).not.toHaveBeenCalled();
  });

  it('uses the same write-ahead ordering for revocation and closure dispatch', async () => {
    const revocationFake = fakePorts();
    const revocationController = createRecoveryController(revocationFake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'revocation-1',
    });
    await revocationController.beginRevocation(DEVICE_TARGET);
    expect(revocationFake.order).toEqual(['save:revocation-1', 'revoke:revocation-1']);

    const closureFake = fakePorts();
    const closureController = createRecoveryController(closureFake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'closure-1',
    });
    await closureController.beginClosure();
    expect(closureFake.order).toEqual(['save:closure-1', 'close:closure-1']);
  });

  it('clears a mismatched saved scope without inspecting it', () => {
    const fake = fakePorts({
      storedReference: { ...operationReference(), roomRevision: 6 },
    });

    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'unused',
    });

    expect(controller.getView().operation).toEqual({ kind: 'idle' });
    expect(fake.resumeStore.clear).toHaveBeenCalledOnce();
    expect(fake.ui.inspectRecovery).not.toHaveBeenCalled();
  });

  it('rejects a closure capability whose room revision is newer than the rendered room', async () => {
    const fake = fakePorts({
      initialSnapshot: snapshot({ closure: { ...snapshot().closure!, expectedRoomRevision: 8 } }),
    });
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'stale-close',
    });

    await expect(controller.beginClosure()).resolves.toBeNull();
    expect(fake.ui.closeRoom).not.toHaveBeenCalled();
    expect(fake.resumeStore.save).not.toHaveBeenCalled();
  });

  it('clears a saved operation from a newer room revision instead of inspecting it', () => {
    const fake = fakePorts({
      initialSnapshot: snapshot({ closure: { ...snapshot().closure!, expectedRoomRevision: 8 } }),
      storedReference: { ...operationReference('closure'), roomRevision: 8 },
    });

    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'unused',
    });

    expect(controller.getView().operation).toEqual({ kind: 'idle' });
    expect(fake.resumeStore.clear).toHaveBeenCalledOnce();
    expect(fake.ui.inspectClosure).not.toHaveBeenCalled();
  });

  it('allows only one nonterminal operation across recovery, revocation and closure', async () => {
    const pending = deferred<ReturnType<typeof outcomeUnknown>>();
    const fake = fakePorts();
    vi.mocked(fake.ui.closeRoom).mockReturnValue(pending.promise);
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'single-flight-1',
    });

    const closure = controller.beginClosure();
    expect(controller.getView().operation).toMatchObject({ kind: 'closure', state: 'pending' });
    await expect(controller.beginRevocation(DEVICE_TARGET)).resolves.toBeNull();
    await expect(controller.beginRecovery('device_backup', async () => null)).resolves.toBeNull();
    expect(fake.ui.revoke).not.toHaveBeenCalled();
    expect(fake.ui.beginRecovery).not.toHaveBeenCalled();

    pending.resolve(outcomeUnknown('single-flight-1'));
    await closure;
  });

  it.each([
    ['account', () => snapshot({
      identity: {
        kind: 'signed_in',
        principal: { ...SIGNED_IN.principal, ownerId: OTHER_OWNER_ID, providerSubject: 'subject-b' },
      },
      closure: { ...snapshot().closure!, ownerId: OTHER_OWNER_ID },
    })],
    ['device generation', () => snapshot({ device: { ...DEVICE, generation: 5 } })],
    ['room revision', () => snapshot({ closure: { ...snapshot().closure!, expectedRoomRevision: 8 } })],
  ])('fences a %s change and ignores the late response', async (_label, replacement) => {
    const pending = deferred<ReturnType<typeof outcomeUnknown>>();
    const fake = fakePorts();
    vi.mocked(fake.ui.closeRoom).mockReturnValue(pending.promise);
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'closure-fenced',
    });

    const closure = controller.beginClosure();
    fake.emit(replacement());

    expect(controller.getView().operation).toEqual({ kind: 'idle' });
    expect(fake.resumeStore.clear).toHaveBeenCalledOnce();
    pending.resolve(outcomeUnknown('closure-fenced'));
    await closure;
    expect(controller.getView().operation).toEqual({ kind: 'idle' });
  });

  it('keeps unknown identity for inspection and refuses a fresh mutation', async () => {
    const fake = fakePorts();
    const ids = ['unknown-1', 'must-not-be-used'];
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => ids.shift()!,
    });

    await controller.beginClosure();
    await expect(controller.beginRecovery('device_backup', async () => null)).resolves.toBeNull();

    expect(fake.ui.closeRoom).toHaveBeenCalledOnce();
    expect(fake.ui.beginRecovery).not.toHaveBeenCalled();
    expect(fake.stored()).toMatchObject({ operationId: 'unknown-1' });
    expect(controller.getView().operation).toMatchObject({ state: 'outcome_unknown' });
  });

  it('inspects a nonterminal revocation under the original operation ID until complete', async () => {
    const fake = fakePorts();
    vi.mocked(fake.ui.revoke).mockResolvedValue(ok({
      operationId: 'revocation-progressing',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'propagating',
    }));
    vi.mocked(fake.ui.inspectRevocation).mockResolvedValue(ok({
      operationId: 'revocation-progressing',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'complete',
    }));
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'revocation-progressing',
    });

    await controller.beginRevocation(DEVICE_TARGET);
    expect(controller.getView().operation).toMatchObject({ state: 'propagating' });
    await controller.inspect();

    expect(fake.ui.inspectRevocation).toHaveBeenCalledWith(
      'revocation-progressing',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.getView().operation).toMatchObject({ state: 'complete' });
  });

  it('keeps a partial revocation inspectable under the original operation ID', async () => {
    const fake = fakePorts();
    vi.mocked(fake.ui.revoke).mockResolvedValue(ok({
      operationId: 'revocation-partial',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'partial',
    }));
    vi.mocked(fake.ui.inspectRevocation).mockResolvedValue(ok({
      operationId: 'revocation-partial',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'complete',
    }));
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'revocation-partial',
    });

    await controller.beginRevocation(DEVICE_TARGET);

    expect(controller.getView().operation).toMatchObject({
      kind: 'revocation', operationId: 'revocation-partial', state: 'partial',
    });
    expect(fake.stored()).toMatchObject({ operationId: 'revocation-partial' });
    expect(fake.resumeStore.clear).not.toHaveBeenCalled();
    await expect(controller.beginClosure()).resolves.toBeNull();

    await controller.inspect();

    expect(fake.ui.inspectRevocation).toHaveBeenCalledWith(
      'revocation-partial',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.getView().operation).toMatchObject({ state: 'complete' });
    expect(fake.stored()).toBeNull();
  });

  it('resumes a partial closure after controller recreation and inspects the same operation ID', async () => {
    const fake = fakePorts();
    vi.mocked(fake.ui.closeRoom).mockResolvedValue(ok({
      operationId: 'closure-partial',
      state: 'partial',
      reason: 'local_cleanup_failed',
    }));
    const firstController = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'closure-partial',
    });

    await firstController.beginClosure();

    expect(firstController.getView().operation).toMatchObject({
      kind: 'closure', operationId: 'closure-partial', state: 'partial',
    });
    expect(fake.stored()).toMatchObject({ operationId: 'closure-partial' });
    expect(fake.resumeStore.clear).not.toHaveBeenCalled();
    firstController.dispose();

    vi.mocked(fake.ui.inspectClosure).mockResolvedValue(ok({
      operationId: 'closure-partial',
      state: 'complete',
      reason: null,
    }));
    const resumedController = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'must-not-be-used',
    });
    await vi.waitFor(() => expect(resumedController.getView().operation).toMatchObject({ state: 'complete' }));

    expect(fake.ui.inspectClosure).toHaveBeenCalledWith(
      'closure-partial',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fake.stored()).toBeNull();
  });

  it('keeps a thrown effectful call inspectable as outcome unknown', async () => {
    const fake = fakePorts();
    vi.mocked(fake.ui.closeRoom).mockRejectedValue(new Error('synthetic transport failure'));
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'closure-threw',
    });

    await controller.beginClosure();

    expect(controller.getView().operation).toMatchObject({
      kind: 'closure', operationId: 'closure-threw', state: 'outcome_unknown',
    });
    expect(fake.stored()).toMatchObject({ operationId: 'closure-threw' });
  });

  it('keeps a cancelled closure wait inspectable and fences its late response', async () => {
    const pending = deferred<ReturnType<typeof outcomeUnknown>>();
    const fake = fakePorts();
    vi.mocked(fake.ui.closeRoom).mockReturnValue(pending.promise);
    vi.mocked(fake.ui.inspectClosure).mockResolvedValue(ok({
      operationId: 'close-cancelled',
      state: 'complete',
      reason: null,
    }));
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'close-cancelled',
    });

    const closing = controller.beginClosure();
    controller.cancel();

    expect(controller.getView().operation).toEqual({
      kind: 'closure', operationId: 'close-cancelled', state: 'outcome_unknown', reason: null,
    });
    expect(fake.stored()).toMatchObject({ operationId: 'close-cancelled' });
    expect(fake.resumeStore.clear).not.toHaveBeenCalled();
    expect(vi.mocked(fake.ui.closeRoom).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(controller.beginRevocation(DEVICE_TARGET)).resolves.toBeNull();
    await expect(controller.beginClosure()).resolves.toBeNull();

    await controller.inspect();
    expect(fake.ui.inspectClosure).toHaveBeenCalledWith(
      'close-cancelled',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.getView().operation).toMatchObject({ state: 'complete' });
    expect(fake.stored()).toBeNull();

    pending.resolve(outcomeUnknown('close-cancelled'));
    await expect(closing).resolves.toBeNull();
    expect(controller.getView().operation).toMatchObject({ state: 'complete' });
  });

  it('keeps a cancelled revocation wait under its original operation ID', async () => {
    const pending = deferred<ReturnType<typeof outcomeUnknown>>();
    const fake = fakePorts();
    vi.mocked(fake.ui.revoke).mockReturnValue(pending.promise);
    vi.mocked(fake.ui.inspectRevocation).mockResolvedValue(ok({
      operationId: 'revoke-cancelled',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'complete',
    }));
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'revoke-cancelled',
    });

    const revoking = controller.beginRevocation(DEVICE_TARGET);
    controller.cancel();

    expect(controller.getView().operation).toEqual({
      kind: 'revocation', operationId: 'revoke-cancelled', state: 'outcome_unknown', reason: null,
    });
    expect(fake.stored()).toMatchObject({ operationId: 'revoke-cancelled' });
    await controller.inspect();
    expect(fake.ui.inspectRevocation).toHaveBeenCalledWith(
      'revoke-cancelled',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.getView().operation).toMatchObject({ state: 'complete' });

    pending.resolve(outcomeUnknown('revoke-cancelled'));
    await expect(revoking).resolves.toBeNull();
    expect(controller.getView().operation).toMatchObject({ state: 'complete' });
  });

  it('retains the write-ahead reference when disposed before an ambiguous response', async () => {
    const pending = deferred<ReturnType<typeof outcomeUnknown>>();
    const fake = fakePorts();
    vi.mocked(fake.ui.closeRoom).mockReturnValue(pending.promise);
    const controller = createRecoveryController(fake.ports, {
      roomId: ROOM_ID,
      roomRevision: 7,
      createOperationId: () => 'close-interrupted',
    });

    const closing = controller.beginClosure();
    controller.dispose();
    pending.resolve(outcomeUnknown('close-interrupted'));
    await closing;

    expect(fake.stored()).toMatchObject({ kind: 'closure', operationId: 'close-interrupted' });
    expect(fake.resumeStore.clear).not.toHaveBeenCalled();
  });
});
