// Synthetic in-memory browser fixture only. It performs no network, durable
// storage, crypto, owner-authority, or real recovery/closure work.

import type {
  BindingId,
  DeviceId,
  DeviceView,
  IdentityState,
  OperationResult,
  OwnerId,
  RevocationProgress,
  RevocationRejection,
  RoomId,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected } from '@khala/contracts/messaging/index';

import type {
  ClosureRejection,
  ClosureStatus,
  RecoveryOperationReference,
  RecoveryPorts,
  RecoverySnapshot,
  RecoveryUiPort,
} from '../ports';

const ownerId = 'owner_synthetic' as OwnerId;
const deviceId = 'device_synthetic' as DeviceId;
const bindingId = 'binding_synthetic' as BindingId;
export const roomId = 'room_synthetic' as RoomId;

const identity: IdentityState = {
  kind: 'signed_in',
  principal: {
    v: 1,
    ownerId,
    providerIssuer: 'https://synthetic.invalid',
    providerSubject: 'synthetic-subject',
    verifiedEmail: 'synthetic@example.invalid',
    sessionExpiresAt: '2030-01-01T00:00:00Z',
  },
};

const device: DeviceView = {
  deviceId,
  state: 'locked',
  generation: 4,
  reason: 'recovery_required',
};

export type SyntheticRevocationOutcome = 'complete' | 'propagating' | 'unknown';

export function createFakeRecoveryPorts() {
  let stored: RecoveryOperationReference | null = null;
  const listeners = new Set<() => void>();
  let revocationOutcome: SyntheticRevocationOutcome = 'complete';
  let promptCount = 0;
  let revokeCount = 0;
  let closeCount = 0;
  let lastRevocationOperationId: string | null = null;
  let inspectedRevocationOperationId: string | null = null;
  let lastClosureOperationId: string | null = null;

  function snapshot(): RecoverySnapshot {
    return {
      identity,
      device,
      history: 'unavailable',
      connection: 'online',
      recovery: { modes: [], unavailableReason: 'unsupported_substrate' },
      revocationTargets: [{ targetKind: 'binding', targetId: bindingId, expectedGeneration: 2 }],
      closure: {
        ownerId,
        roomId,
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
    } as RecoverySnapshot;
  }

  const ui: RecoveryUiPort = {
    snapshot,
    subscribe(listener, signal) {
      listeners.add(listener);
      const dispose = () => listeners.delete(listener);
      signal.addEventListener('abort', dispose, { once: true });
      return dispose;
    },
    async beginRecovery(_input, _provideSecret) {
      void _input;
      void _provideSecret;
      promptCount += 1;
      return rejected('unsupported_mode');
    },
    async inspectRecovery(_operationId) {
      void _operationId;
      return rejected('not_found');
    },
    async revoke(input) {
      revokeCount += 1;
      lastRevocationOperationId = input.operationId;
      if (revocationOutcome === 'unknown') return outcomeUnknown(input.operationId);
      return ok({
        operationId: input.operationId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        generation: input.expectedGeneration + 1,
        state: revocationOutcome,
      }) as OperationResult<RevocationProgress, RevocationRejection>;
    },
    async inspectRevocation(operationId) {
      inspectedRevocationOperationId = operationId;
      return ok({
        operationId,
        targetKind: 'binding',
        targetId: bindingId,
        generation: 3,
        state: 'complete',
      });
    },
    async closeRoom(input): Promise<OperationResult<ClosureStatus, ClosureRejection>> {
      closeCount += 1;
      lastClosureOperationId = input.operationId;
      return ok({ operationId: input.operationId, state: 'complete', reason: null });
    },
    async inspectClosure(operationId) {
      return outcomeUnknown(operationId);
    },
  };

  const ports: RecoveryPorts = {
    ui,
    resumeStore: {
      load: () => stored,
      save: reference => { stored = reference; },
      clear: () => { stored = null; },
    },
  };

  return {
    ports,
    setRevocationOutcome(outcome: SyntheticRevocationOutcome) {
      revocationOutcome = outcome;
    },
    emitUnchanged() {
      listeners.forEach(listener => listener());
    },
    getAudit() {
      return {
        promptCount,
        revokeCount,
        closeCount,
        lastRevocationOperationId,
        inspectedRevocationOperationId,
        lastClosureOperationId,
        storedReference: stored,
      };
    },
  };
}
