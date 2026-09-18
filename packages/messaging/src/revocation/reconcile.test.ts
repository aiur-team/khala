// U2: the protocol and endpoint boundaries reconcile independently. A mocked SDK proves
// module behaviour only.

import type { BindingId, DeviceId, OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { type OperationRecord, newOperation, operationState, toProgress, toStatus } from './operation';
import {
  type DeviceRemovalResult, type DeviceStatusResult, type ProtocolRevocationPort, applyAcknowledgment, reconcileProtocol,
} from './reconcile';

const alice = 'owner_alice' as OwnerId;
const laptop = 'device_laptop' as DeviceId;
const binding = 'binding_claude_1' as BindingId;

const disabledDevice: OperationRecord = {
  ...newOperation(alice, { operationId: 'op_1', targetKind: 'device', targetId: laptop, expectedGeneration: 3 }),
  control: 'disabled',
};
const disabledBinding: OperationRecord = {
  ...newOperation(alice, { operationId: 'op_2', targetKind: 'binding', targetId: binding, expectedGeneration: 1 }),
  control: 'disabled',
};

/** Scripted SDK: each call takes the next scripted answer. */
function scripted(removals: DeviceRemovalResult['kind'][], statuses: DeviceStatusResult['kind'][]) {
  const calls: string[] = [];
  const protocol: ProtocolRevocationPort = {
    async removeDevice(input) {
      calls.push(`remove:${input.operationId}:${input.deviceId}`);
      const kind = removals.shift();
      if (kind === undefined) throw new Error('unexpected removal');
      return kind === 'refused' ? { kind, reason: 'reauthentication_required' } : { kind };
    },
    async deviceStatus(deviceId) {
      calls.push(`status:${deviceId}`);
      const kind = statuses.shift();
      if (kind === undefined) throw new Error('unexpected status read');
      return { kind };
    },
  };
  return { protocol, calls };
}

describe('reconcileProtocol', () => {
  it('queries status after a lost response instead of assuming removal', async () => {
    const sdk = scripted(['outcome_unknown'], ['unavailable']);
    const record = await reconcileProtocol(disabledDevice, sdk.protocol);
    expect(record.protocol).toBe('unknown');
    expect(operationState(record)).toBe('protocol_pending');
    expect(toProgress(record)?.state).toBe('propagating');
    expect(sdk.calls).toEqual([`remove:op_1:${laptop}`, `status:${laptop}`]);
  });

  it('confirms removal from status on the next pass without asking again', async () => {
    const sdk = scripted([], ['removed']);
    const record = await reconcileProtocol({ ...disabledDevice, protocol: 'unknown' }, sdk.protocol);
    expect(record.protocol).toBe('confirmed');
    expect(sdk.calls).toEqual([`status:${laptop}`]);
  });

  it('asks again once status proves the device is still present', async () => {
    const sdk = scripted(['removed'], ['present']);
    const record = await reconcileProtocol({ ...disabledDevice, protocol: 'unknown' }, sdk.protocol);
    expect(record.protocol).toBe('confirmed');
    expect(sdk.calls).toEqual([`status:${laptop}`, `remove:op_1:${laptop}`]);
  });

  it('returns a lost removal to pending when the device is provably still present', async () => {
    const sdk = scripted(['outcome_unknown'], ['present']);
    expect((await reconcileProtocol(disabledDevice, sdk.protocol)).protocol).toBe('pending');
  });

  it('leaves the record unchanged when status stays unreadable', async () => {
    const unknown: OperationRecord = { ...disabledDevice, protocol: 'unknown' };
    expect(await reconcileProtocol(unknown, scripted([], ['unavailable']).protocol)).toBe(unknown);
  });

  it('leaves the record unchanged when the SDK is unavailable', async () => {
    expect(await reconcileProtocol(disabledDevice, scripted(['unavailable'], []).protocol)).toBe(disabledDevice);
  });

  it('reports a refusal as partial until a later attempt succeeds', async () => {
    const refused = await reconcileProtocol(disabledDevice, scripted(['refused'], []).protocol);
    expect([refused.protocol, refused.protocolRefusal, operationState(refused), toStatus(refused).retryable])
      .toEqual(['refused', 'reauthentication_required', 'partial', true]);
    const retried = await reconcileProtocol(refused, scripted(['removed'], []).protocol);
    expect([retried.protocol, retried.protocolRefusal]).toEqual(['confirmed', null]);
  });

  it('never acts on a superseded device', async () => {
    const superseded: OperationRecord = { ...disabledDevice, protocol: 'superseded' };
    expect(await reconcileProtocol(superseded, scripted([], []).protocol)).toBe(superseded);
    expect([operationState(superseded), toStatus(superseded).retryable]).toEqual(['partial', false]);
  });

  it('touches neither a binding nor a device whose disable has not landed', async () => {
    const sdk = scripted([], []);
    expect(await reconcileProtocol(disabledBinding, sdk.protocol)).toBe(disabledBinding);
    const requested = { ...disabledDevice, control: 'pending' as const };
    expect(await reconcileProtocol(requested, sdk.protocol)).toBe(requested);
    expect(sdk.calls).toEqual([]);
  });
});

describe('endpoint acknowledgment', () => {
  const ack = { operationId: 'op_2', targetKind: 'binding' as const, targetId: binding, generation: 2 };

  it('keeps an offline endpoint pending: partial, never complete, and not fixable by resubmitting', () => {
    const status = toStatus(disabledBinding);
    expect([status.state, status.control, status.endpoint, status.retryable]).toEqual(['partial', 'disabled', 'pending', false]);
    expect(toProgress(disabledBinding)?.state).toBe('partial');
  });

  it('completes the operation on the revoked generation acknowledgment', () => {
    const { outcome, record } = applyAcknowledgment(disabledBinding, ack);
    expect(outcome).toBe('recorded');
    expect(toProgress(record)?.state).toBe('complete');
    expect(toStatus(record).retryable).toBe(false);
  });

  it('treats a duplicate acknowledgment as harmless', () => {
    const once = applyAcknowledgment(disabledBinding, ack).record;
    const twice = applyAcknowledgment(once, ack);
    expect(twice).toEqual({ outcome: 'duplicate', record: once });
  });

  it('ignores a previous-generation callback and one for a replacement target', () => {
    expect(applyAcknowledgment(disabledBinding, { ...ack, generation: 1 }).outcome).toBe('ignored');
    expect(applyAcknowledgment(disabledBinding, { ...ack, generation: 3 }).outcome).toBe('ignored');
    expect(applyAcknowledgment(disabledBinding, { ...ack, targetId: 'binding_claude_2' as BindingId }).outcome).toBe('ignored');
    expect(applyAcknowledgment(disabledBinding, { ...ack, operationId: 'op_other' }).outcome).toBe('ignored');
  });

  it('holds an acknowledgment that arrives before the disable is recorded as early, not ignored', () => {
    expect(applyAcknowledgment({ ...disabledBinding, control: 'pending' }, ack).outcome).toBe('early');
    expect(applyAcknowledgment({ ...disabledBinding, control: 'stale' }, ack).outcome).toBe('ignored');
  });

  it('needs both a confirmed protocol effect and an acknowledgment for a device', () => {
    const acked = applyAcknowledgment(disabledDevice, { ...ack, operationId: 'op_1', targetKind: 'device', targetId: laptop, generation: 4 }).record;
    expect(operationState(acked)).toBe('local_disabled');
    expect(operationState({ ...acked, protocol: 'confirmed' })).toBe('completed');
    expect(operationState({ ...disabledDevice, protocol: 'confirmed' })).toBe('partial');
  });
});

describe('limitations', () => {
  it('always reports what a revocation cannot recall', () => {
    expect(toStatus(disabledDevice).limitations)
      .toEqual(['disclosed_content_not_recalled', 'retained_keys_not_recalled', 'other_devices_unaffected']);
    expect(toStatus(disabledBinding).limitations)
      .toEqual(['disclosed_content_not_recalled', 'device_keys_unchanged', 'account_and_membership_unchanged']);
  });
});
