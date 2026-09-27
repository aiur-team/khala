import { describe, expect, it } from 'vitest';
import { CLOSURE_CONSEQUENCES, decodeClosureCapability, decodeClosureConnectorReceipt, decodeClosureRequest, decodeClosureStatus } from './closure';

describe('channel closure contract', () => {
  it('binds operation identity to owner, channel and generation with exact fields', () => {
    const command = { operationId: 'close_1', ownerId: 'owner_1', roomId: 'room_1', expectedRoomRevision: 0 };
    expect(decodeClosureRequest(command).ok).toBe(true);
    expect(decodeClosureRequest({ ...command, unexpected: true })).toMatchObject({ ok: false, error: { path: 'unexpected' } });
    expect(decodeClosureRequest({ ...command, expectedRoomRevision: -1 }).ok).toBe(false);
    expect(decodeClosureRequest({ ...command, operationId: '' }).ok).toBe(false);
  });

  it('refuses invented deletion promises and contradictory capability or status', () => {
    const capability = { ownerId: 'owner_1', roomId: 'room_1', expectedRoomRevision: 0,
      available: true, unavailableReason: null, consequences: CLOSURE_CONSEQUENCES };
    expect(decodeClosureCapability(capability).ok).toBe(true);
    expect(decodeClosureCapability({ ...capability, consequences: { ...CLOSURE_CONSEQUENCES, recallsDeliveredCopies: true } }).ok).toBe(false);
    expect(decodeClosureCapability({ ...capability, unavailableReason: 'stale_room' }).ok).toBe(false);
    expect(decodeClosureStatus({ operationId: 'close_1', state: 'complete', reason: 'local_cleanup_failed' }).ok).toBe(false);
  });

  it('requires an aggregate connector stop and cleanup request receipt', () => {
    const receipt = { operationId: 'close_1', ownerId: 'owner_1', roomId: 'room_1', expectedRoomRevision: 0,
      markerRevision: 3, activeBindingCount: 2,
      fencedBindings: [{ bindingId: 'binding_1', generation: 4 }, { bindingId: 'binding_2', generation: 7 }],
      state: 'stopped', futureBindingAdmissionBlocked: true, relayPollBlocked: true, relayIntakeBlocked: true,
      modelDispatchBlocked: true, cleanupRequested: true };
    expect(decodeClosureConnectorReceipt(receipt).ok).toBe(true);
    expect(decodeClosureConnectorReceipt({ ...receipt, cleanupRequested: false }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, markerRevision: 0 }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, activeBindingCount: 1 }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, futureBindingAdmissionBlocked: false }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, relayPollBlocked: false }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, fencedBindings: [receipt.fencedBindings[0], receipt.fencedBindings[0]] }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, fencedBindings: [{ bindingId: 'binding_1', generation: -1 }] }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, bindingId: 'binding_1', bindingGeneration: 4 }).ok).toBe(false);
    expect(decodeClosureConnectorReceipt({ ...receipt, extra: true }).ok).toBe(false);
  });
});
