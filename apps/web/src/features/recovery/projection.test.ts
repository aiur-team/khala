import { describe, expect, it } from 'vitest';
import type {
  DeviceId, DeviceView, IdentityState, OwnerId, RecoveryCapabilities, RoomId,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown } from '@khala/contracts/messaging/index';

import {
  IDLE_RECOVERY_OPERATION,
  isRecoveryModeAllowed,
  projectClosureOperation,
  projectRecoveryOperation,
  projectRecoveryView,
  projectRevocationOperation,
} from './model';
import type { RecoverySnapshot } from './ports';

const OWNER_ID = 'owner-a' as OwnerId;
const DEVICE_ID = 'device-a' as DeviceId;
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

const READY_DEVICE: DeviceView = {
  deviceId: DEVICE_ID,
  state: 'ready',
  generation: 4,
  reason: null,
};

const RECOVERY_CAPABILITIES: RecoveryCapabilities = {
  modes: ['device_backup'],
  unavailableReason: null,
};

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    identity: SIGNED_IN,
    device: READY_DEVICE,
    history: 'available',
    connection: 'online',
    recovery: RECOVERY_CAPABILITIES,
    revocationTargets: [
      { targetKind: 'device', targetId: DEVICE_ID, expectedGeneration: 4 },
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

describe('recovery projection', () => {
  it('keeps successful authentication separate from unavailable history keys (AE1)', () => {
    const view = projectRecoveryView(snapshot({
      device: { deviceId: DEVICE_ID, state: 'locked', generation: 4, reason: 'key_material_missing' },
      history: 'unavailable',
    }));

    expect(view.identityState).toBe('signed_in');
    expect(view.deviceState).toBe('locked');
    expect(view.history).toBe('unavailable');
    expect(view.history).not.toBe('available');
  });

  it('does not upgrade partial history when connectivity becomes online', () => {
    const offline = projectRecoveryView(snapshot({ history: 'partial', connection: 'offline' }));
    const online = projectRecoveryView(snapshot({ history: 'partial', connection: 'online' }));

    expect(offline.history).toBe('partial');
    expect(online.history).toBe('partial');
  });

  it('keeps recovery unavailable under P14 even if a stale mode appears', () => {
    const view = projectRecoveryView(snapshot());

    expect(view.allowedActions).not.toContain('recover');
    expect(view.recoveryModes).toEqual([]);
    expect(isRecoveryModeAllowed(view, 'device_backup')).toBe(false);
    expect(isRecoveryModeAllowed(view, 'escrow')).toBe(false);
  });

  it('fails closed when identity or capabilities are unavailable', () => {
    const view = projectRecoveryView(snapshot({
      identity: { kind: 'unavailable', retryable: true },
      recovery: { modes: [], unavailableReason: 'signed_out' },
      revocationTargets: [],
      closure: null,
    }));

    expect(view.identityState).toBe('unavailable');
    expect(view.allowedActions).toEqual([]);
    expect(view.recoveryModes).toEqual([]);
  });

  it('projects recovery, revocation and closure outcomes into distinct operation kinds', () => {
    const recovery = projectRecoveryOperation('recovery-1', ok({
      operationId: 'recovery-1',
      mode: 'device_backup',
      state: 'restoring',
      reason: null,
    }));
    const revocation = projectRevocationOperation('revocation-1', ok({
      operationId: 'revocation-1',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'complete',
    }));
    const closure = projectClosureOperation('closure-1', ok({
      operationId: 'closure-1',
      state: 'complete',
      reason: null,
    }));

    expect(recovery).toMatchObject({ kind: 'recovery', state: 'restoring' });
    expect(revocation).toMatchObject({ kind: 'revocation', state: 'complete' });
    expect(closure).toMatchObject({ kind: 'closure', state: 'complete' });
  });

  it('keeps an unknown outcome under its original kind and operation identity', () => {
    const operation = projectClosureOperation('closure-1', outcomeUnknown('closure-1'));

    expect(operation).toEqual({
      kind: 'closure',
      operationId: 'closure-1',
      state: 'outcome_unknown',
      reason: null,
    });
    expect(projectRecoveryView(snapshot(), operation).allowedActions).toEqual([]);
  });

  it.each([
    ['recovery', () => projectRecoveryOperation('requested-recovery', ok({
      operationId: 'different-recovery',
      mode: 'device_backup',
      state: 'restored',
      reason: null,
    }))],
    ['revocation', () => projectRevocationOperation('requested-revocation', ok({
      operationId: 'different-revocation',
      targetKind: 'device',
      targetId: DEVICE_ID,
      generation: 5,
      state: 'complete',
    }))],
    ['closure', () => projectClosureOperation('requested-closure', ok({
      operationId: 'different-closure',
      state: 'complete',
      reason: null,
    }))],
  ] as const)('keeps the requested %s ID when a successful result carries a mismatched ID', (kind, project) => {
    const operation = project();

    expect(operation).toEqual({
      kind,
      operationId: `requested-${kind}`,
      state: 'outcome_unknown',
      reason: null,
    });
  });

  it('contains no secret-bearing field in its serializable display state', () => {
    const serialized = JSON.stringify(projectRecoveryView(snapshot(), IDLE_RECOVERY_OPERATION));

    expect(serialized).not.toMatch(/secret|password|keyMaterial/i);
  });
});
