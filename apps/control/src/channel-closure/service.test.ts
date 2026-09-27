import { describe, expect, it, vi } from 'vitest';
import { type AuthPrincipal, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { createChannelClosureService, type ClosureTransport } from './service';

const ownerId = 'owner_alice' as OwnerId;
const roomId = 'room_one' as RoomId;
const principal: AuthPrincipal = {
  v: 1, ownerId, providerIssuer: 'https://issuer.example', providerSubject: 'alice',
  verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z',
};

function blobs(): BlobsStoreLike {
  const records = new Map<string, { data: unknown; etag: string }>();
  let sequence = 0;
  return {
    async getWithMetadata(key) { return records.get(key) ?? null; },
    async setJSON(key, data, options) {
      const current = records.get(key);
      if (options?.onlyIfNew && current) return { modified: false };
      if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false };
      const etag = String(++sequence);
      records.set(key, { data, etag });
      return { modified: true, etag };
    },
  };
}

function setup() {
  const store = createControlStore({ records: blobs(), operations: blobs(), clock: () => 0 });
  const transport: ClosureTransport = {
    connectorConfigured: true,
    membership: vi.fn(async () => 'joined' as const),
    stopConnectorDelivery: vi.fn(async input => ({ kind: 'stopped' as const, receipt: {
      ...input, markerRevision: 2, activeBindingCount: 2,
      fencedBindings: [{ bindingId: 'binding_alice_1' as never, generation: 1 },
        { bindingId: 'binding_alice_2' as never, generation: 3 }],
      state: 'stopped' as const, futureBindingAdmissionBlocked: true as const,
      relayPollBlocked: true as const, relayIntakeBlocked: true as const,
      modelDispatchBlocked: true as const, cleanupRequested: true as const,
    } })),
    leave: vi.fn(async () => 'left' as const),
    requestLocalCleanup: vi.fn(async () => 'requested' as const),
  };
  const service = createChannelClosureService({ principal, store, transport });
  return { service, transport, store };
}

const request = { operationId: 'close_1', ownerId, roomId, expectedRoomRevision: 0 } as const;

describe('channel closure service', () => {
  it('ends owner participation, requests cleanup, then replays one stable result', async () => {
    const { service, transport } = setup();
    expect(await service.capability(roomId)).toMatchObject({ kind: 'ok', value: { available: true, ownerId, roomId } });
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: { operationId: 'close_1', state: 'complete', reason: null } });
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: { operationId: 'close_1', state: 'complete', reason: null } });
    expect(transport.leave).toHaveBeenCalledTimes(1);
    expect(await service.inspectClosure('close_1')).toEqual({ kind: 'ok', value: { operationId: 'close_1', state: 'complete', reason: null } });
    expect(await service.capability(roomId)).toMatchObject({ kind: 'ok', value: { available: false } });
  });

  it('rejects wrong owners, cross-channel operation reuse and stale generations before leave', async () => {
    const { service, transport } = setup();
    expect(await service.closeRoom({ ...request, ownerId: 'owner_bob' as OwnerId })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await service.closeRoom({ ...request, expectedRoomRevision: 1 })).toEqual({ kind: 'rejected', code: 'stale_room' });
    await service.closeRoom(request);
    expect(await service.closeRoom({ ...request, roomId: 'room_other' as RoomId })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(await service.closeRoom({ ...request, operationId: 'close_2' })).toEqual({ kind: 'rejected', code: 'stale_room' });
    expect(transport.leave).toHaveBeenCalledTimes(1);
  });

  it('keeps offline transport and local cleanup failures visibly partial', async () => {
    const { service, transport } = setup();
    vi.mocked(transport.leave).mockResolvedValueOnce('unknown');
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
      operationId: 'close_1', state: 'partial', reason: 'dependency_unavailable',
    } });
    vi.mocked(transport.requestLocalCleanup).mockResolvedValueOnce('unavailable');
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
      operationId: 'close_1', state: 'partial', reason: 'local_cleanup_failed',
    } });
    expect(transport.leave).toHaveBeenCalledTimes(2);
    vi.mocked(transport.stopConnectorDelivery).mockResolvedValueOnce({ kind: 'unavailable' });
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
      operationId: 'close_1', state: 'partial', reason: 'local_cleanup_failed',
    } });
    expect(transport.requestLocalCleanup).toHaveBeenCalledTimes(1);
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
      operationId: 'close_1', state: 'complete', reason: null,
    } });
    expect(transport.leave).toHaveBeenCalledTimes(2);
  });

  it('does not leave the human account while connector delivery remains live or unconfirmed', async () => {
    const { service, transport } = setup();
    vi.mocked(transport.stopConnectorDelivery).mockResolvedValueOnce({ kind: 'pending' });
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
      operationId: 'close_1', state: 'partial', reason: 'dependency_unavailable',
    } });
    expect(transport.leave).not.toHaveBeenCalled();
    expect(transport.requestLocalCleanup).not.toHaveBeenCalled();
    expect(await service.closeRoom(request)).toMatchObject({ kind: 'ok', value: { state: 'complete' } });
    expect(transport.stopConnectorDelivery).toHaveBeenCalledWith(request, undefined);
    expect(transport.leave).toHaveBeenCalledTimes(1);
  });

  it('does not offer closure or create an intent without a protected connector mailbox', async () => {
    const { transport, store } = setup();
    const service = createChannelClosureService({ principal, store, transport: { ...transport, connectorConfigured: false } });
    expect(await service.capability(roomId)).toMatchObject({ kind: 'ok', value: {
      available: false, unavailableReason: 'not_configured',
    } });
    expect(await service.closeRoom(request)).toMatchObject({ kind: 'unavailable' });
    expect(transport.membership).not.toHaveBeenCalled();
    expect(transport.leave).not.toHaveBeenCalled();
  });

  it('does not leave for a connector receipt from another channel', async () => {
    const { service, transport } = setup();
    vi.mocked(transport.stopConnectorDelivery).mockResolvedValueOnce({ kind: 'stopped', receipt: {
      ...request, roomId: 'room_other' as RoomId, markerRevision: 2, activeBindingCount: 1,
      fencedBindings: [{ bindingId: 'binding_alice' as never, generation: 1 }],
      state: 'stopped', futureBindingAdmissionBlocked: true, relayPollBlocked: true, relayIntakeBlocked: true,
      modelDispatchBlocked: true, cleanupRequested: true,
    } });
    expect(await service.closeRoom(request)).toMatchObject({ kind: 'ok', value: {
      state: 'partial', reason: 'dependency_unavailable',
    } });
    expect(transport.leave).not.toHaveBeenCalled();
  });

  it('does not leave for a single-binding receipt that lacks aggregate coverage', async () => {
    const { service, transport } = setup();
    vi.mocked(transport.stopConnectorDelivery).mockResolvedValueOnce({ kind: 'stopped', receipt: {
      ...request, bindingId: 'binding_alice' as never, bindingGeneration: 1,
      state: 'stopped', cleanupRequested: true,
    } as never });
    expect(await service.closeRoom(request)).toMatchObject({ kind: 'ok', value: {
      state: 'partial', reason: 'dependency_unavailable',
    } });
    expect(transport.leave).not.toHaveBeenCalled();
  });
});
