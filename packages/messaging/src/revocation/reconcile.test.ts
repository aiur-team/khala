// U2: the protocol and endpoint boundaries reconcile independently. A mocked SDK proves
// module behaviour only.

import type { BindingId, DeviceId, OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { type OperationRecord, newOperation, operationState, toProgress, toStatus } from './operation';
import {
  type DeviceRemovalResult, type DeviceStatusResult, type ProtocolRevocationPort, type SessionRotationResult,
  applyAcknowledgment, reconcileRemoval, reconcileRotation,
} from './reconcile';

const alice = 'owner_alice' as OwnerId;
const laptop = 'device_laptop' as DeviceId;
const agentDevice = 'device_agent' as DeviceId;
const binding = 'binding_claude_1' as BindingId;

const disabledDevice: OperationRecord = {
  ...newOperation(alice, { operationId: 'op_1', targetKind: 'device', targetId: laptop, expectedGeneration: 3 }, { deviceId: laptop, deviceKey: 'key_laptop' }),
  control: 'disabled',
};
const disabledBinding: OperationRecord = {
  ...newOperation(alice, { operationId: 'op_2', targetKind: 'binding', targetId: binding, expectedGeneration: 1 }, { deviceId: agentDevice, deviceKey: 'key_agent' }),
  control: 'disabled',
  capability: 'revoked',
};
const excludedDevice: OperationRecord = { ...disabledDevice, removal: 'removed', rotation: 'rotated' };
const excludedBinding: OperationRecord = { ...disabledBinding, removal: 'removed', rotation: 'rotated' };

/** Scripted SDK: each call takes the next scripted answer. */
function scripted(
  removals: DeviceRemovalResult['kind'][],
  statuses: DeviceStatusResult['kind'][],
  rotations: SessionRotationResult['kind'][] = [],
) {
  const calls: string[] = [];
  const protocol: ProtocolRevocationPort = {
    async removeDevice(input) {
      calls.push(`remove:${input.operationId}:${input.deviceId}:${input.deviceKey}`);
      const kind = removals.shift();
      if (kind === undefined) throw new Error('unexpected removal');
      return kind === 'refused' ? { kind, reason: 'reauthentication_required' } : { kind };
    },
    async deviceStatus(input) {
      calls.push(`status:${input.deviceId}`);
      const kind = statuses.shift();
      if (kind === undefined) throw new Error('unexpected status read');
      return { kind };
    },
    async rotateSessions(input) {
      calls.push(`rotate:${input.operationId}:${input.deviceKey}`);
      const kind = rotations.shift();
      if (kind === undefined) throw new Error('unexpected rotation');
      return { kind };
    },
  };
  return { protocol, calls };
}

describe('reconcileRemoval', () => {
  it('queries status after a lost response instead of assuming removal', async () => {
    const sdk = scripted(['outcome_unknown'], ['unavailable']);
    const record = await reconcileRemoval(disabledDevice, sdk.protocol);
    expect(record.removal).toBe('unknown');
    expect(operationState(record)).toBe('protocol_pending');
    expect(toProgress(record)?.state).toBe('propagating');
    expect(sdk.calls).toEqual([`remove:op_1:${laptop}:key_laptop`, `status:${laptop}`]);
  });

  it('confirms removal from status on the next pass without asking again', async () => {
    const sdk = scripted([], ['removed']);
    const record = await reconcileRemoval({ ...disabledDevice, removal: 'unknown' }, sdk.protocol);
    expect(record.removal).toBe('removed');
    expect(sdk.calls).toEqual([`status:${laptop}`]);
  });

  it('asks again once status proves the device is still present', async () => {
    const sdk = scripted(['removed'], ['present']);
    const record = await reconcileRemoval({ ...disabledDevice, removal: 'unknown' }, sdk.protocol);
    expect(record.removal).toBe('removed');
    expect(sdk.calls).toEqual([`status:${laptop}`, `remove:op_1:${laptop}:key_laptop`]);
  });

  it('returns a lost removal to pending when the device is provably still present', async () => {
    const sdk = scripted(['outcome_unknown'], ['present']);
    expect((await reconcileRemoval(disabledDevice, sdk.protocol)).removal).toBe('pending');
  });

  it('marks a device ID now holding another key as superseded, from removal or from status', async () => {
    expect((await reconcileRemoval(disabledDevice, scripted(['replaced'], []).protocol)).removal).toBe('superseded');
    expect((await reconcileRemoval(disabledDevice, scripted(['outcome_unknown'], ['replaced']).protocol)).removal).toBe('superseded');
    expect((await reconcileRemoval({ ...disabledDevice, removal: 'unknown' }, scripted([], ['replaced']).protocol)).removal).toBe('superseded');
  });

  it('leaves the record unchanged when status stays unreadable', async () => {
    const unknown: OperationRecord = { ...disabledDevice, removal: 'unknown' };
    expect(await reconcileRemoval(unknown, scripted([], ['unavailable']).protocol)).toBe(unknown);
  });

  it('leaves the record unchanged when the SDK is unavailable', async () => {
    expect(await reconcileRemoval(disabledDevice, scripted(['unavailable'], []).protocol)).toBe(disabledDevice);
  });

  it('reports a refusal as partial until a later attempt succeeds', async () => {
    const refused = await reconcileRemoval(disabledDevice, scripted(['refused'], []).protocol);
    expect([refused.removal, refused.removalRefusal, operationState(refused), toStatus(refused).retryable])
      .toEqual(['refused', 'reauthentication_required', 'partial', true]);
    const retried = await reconcileRemoval(refused, scripted(['removed'], []).protocol);
    expect([retried.removal, retried.removalRefusal]).toEqual(['removed', null]);
  });

  it('never acts again on a settled removal, or before the disable has landed', async () => {
    const sdk = scripted([], []);
    for (const removal of ['removed', 'superseded'] as const) {
      const settled: OperationRecord = { ...disabledDevice, removal };
      expect(await reconcileRemoval(settled, sdk.protocol)).toBe(settled);
    }
    const requested = { ...disabledDevice, control: 'pending' as const };
    expect(await reconcileRemoval(requested, sdk.protocol)).toBe(requested);
    expect(sdk.calls).toEqual([]);
  });
});

describe('reconcileRotation', () => {
  it('rotates only after removal settles', async () => {
    const sdk = scripted([], [], ['rotated']);
    expect(await reconcileRotation(disabledDevice, sdk.protocol)).toBe(disabledDevice);
    const rotated = await reconcileRotation({ ...disabledDevice, removal: 'removed' }, sdk.protocol);
    expect(rotated.rotation).toBe('rotated');
    expect(sdk.calls).toEqual(['rotate:op_1:key_laptop']);
  });

  it('keeps a removed device protocol_pending until rotation is confirmed', async () => {
    const removed: OperationRecord = { ...disabledDevice, removal: 'removed', endpoint: 'acknowledged' };
    expect(operationState(removed)).toBe('protocol_pending');
    expect(toStatus(removed).retryable).toBe(true);
    for (const kind of ['outcome_unknown', 'unavailable'] as const) {
      expect(await reconcileRotation(removed, scripted([], [], [kind]).protocol)).toBe(removed);
    }
    expect(operationState({ ...removed, rotation: 'rotated' })).toBe('completed');
  });

  it("rotates a superseded device's old key out but reports it partial", async () => {
    const superseded: OperationRecord = { ...disabledDevice, removal: 'superseded', endpoint: 'acknowledged' };
    const rotated = await reconcileRotation(superseded, scripted([], [], ['rotated']).protocol);
    expect([operationState(rotated), toStatus(rotated).retryable]).toEqual(['partial', false]);
  });
});

describe('endpoint acknowledgment', () => {
  const ack = { operationId: 'op_1', targetKind: 'device' as const, targetId: laptop, generation: 4 };

  it('keeps an offline endpoint pending: partial, never complete, and not fixable by resubmitting', () => {
    const status = toStatus(excludedDevice);
    expect([status.state, status.control, status.endpoint, status.retryable]).toEqual(['partial', 'disabled', 'pending', false]);
    expect(toProgress(excludedDevice)?.state).toBe('partial');
  });

  it('completes a device operation on the revoked generation acknowledgment', () => {
    const { outcome, record } = applyAcknowledgment(excludedDevice, ack);
    expect(outcome).toBe('recorded');
    expect(toProgress(record)?.state).toBe('complete');
    expect(toStatus(record).retryable).toBe(false);
  });

  it('keeps an acknowledged binding partial, because room membership is unchanged', () => {
    const { record } = applyAcknowledgment(excludedBinding, { ...ack, operationId: 'op_2', targetKind: 'binding', targetId: binding, generation: 2 });
    expect([record.endpoint, operationState(record), toStatus(record).retryable]).toEqual(['acknowledged', 'partial', false]);
  });

  it('treats a duplicate acknowledgment as harmless', () => {
    const once = applyAcknowledgment(excludedDevice, ack).record;
    const twice = applyAcknowledgment(once, ack);
    expect(twice).toEqual({ outcome: 'duplicate', record: once });
  });

  it('ignores a previous-generation callback and one for a replacement target', () => {
    expect(applyAcknowledgment(excludedDevice, { ...ack, generation: 3 }).outcome).toBe('ignored');
    expect(applyAcknowledgment(excludedDevice, { ...ack, generation: 5 }).outcome).toBe('ignored');
    expect(applyAcknowledgment(excludedDevice, { ...ack, targetId: 'device_other' as DeviceId }).outcome).toBe('ignored');
    expect(applyAcknowledgment(excludedDevice, { ...ack, operationId: 'op_other' }).outcome).toBe('ignored');
  });

  it('holds an acknowledgment that arrives before the disable is recorded as early, not ignored', () => {
    expect(applyAcknowledgment({ ...disabledDevice, control: 'pending' }, ack).outcome).toBe('early');
    expect(applyAcknowledgment({ ...disabledDevice, control: 'stale' }, ack).outcome).toBe('ignored');
  });

  it('needs removal, rotation and an acknowledgment for a device', () => {
    const acked = applyAcknowledgment(disabledDevice, ack).record;
    expect(operationState(acked)).toBe('local_disabled');
    expect(operationState({ ...acked, removal: 'removed' })).toBe('protocol_pending');
    expect(operationState({ ...acked, removal: 'removed', rotation: 'rotated' })).toBe('completed');
  });
});

describe('limitations', () => {
  it('always reports what a revocation cannot recall', () => {
    expect(toStatus(disabledDevice).limitations)
      .toEqual(['disclosed_content_not_recalled', 'retained_keys_not_recalled', 'other_devices_unaffected']);
    expect(toStatus(disabledBinding).limitations)
      .toEqual(['disclosed_content_not_recalled', 'retained_keys_not_recalled', 'account_and_membership_unchanged']);
  });
});
