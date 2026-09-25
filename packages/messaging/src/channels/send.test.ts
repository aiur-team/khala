import { describe, expect, it } from 'vitest';
import type { DeviceId } from '@khala/contracts/messaging/index';
import { harness, text } from './fixtures/fakes';

describe('channel send', () => {
  it('accepts a message and returns its immutable reference', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    const result = await service.send({ roomId: room.roomId, clientTxnId: 'c-1', content: text('hello') });
    expect(result).toMatchObject({ kind: 'ok', value: { clientTxnId: 'c-1', state: 'accepted', eventRef: { eventId: '$event-1', authorDeviceId: 'device-1' } } });
  });

  it('keeps a failed message retryable with the same transaction and bytes', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = (_, attempt) => (attempt === 0 ? 'unavailable' : 'accept');
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-2', content: text('hello') })).toEqual({ kind: 'unavailable', retryable: true });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-2', content: text('hello!') })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-2', content: text('hello') })).toMatchObject({ kind: 'ok', value: { state: 'accepted' } });
    expect(substrate.sendCalls).toEqual([{ clientTxnId: 'c-2', body: 'hello' }, { clientTxnId: 'c-2', body: 'hello' }]);
  });

  it('reports an unknown outcome under the client transaction and resolves it by re-sending', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = (_, attempt) => (attempt === 0 ? 'throw' : 'accept');
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-3', content: text('hi') })).toEqual({ kind: 'outcome_unknown', operationId: 'c-3' });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-3', content: text('hi') })).toMatchObject({ kind: 'ok', value: { state: 'accepted' } });
    expect(substrate.landed).toHaveLength(1);
  });

  it('returns an accepted send without contacting the transport again', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    const first = await service.send({ roomId: room.roomId, clientTxnId: 'c-4', content: text('hi') });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-4', content: text('hi') })).toEqual(first);
    expect(substrate.sendCalls).toHaveLength(1);
  });

  it('blocks new sends after membership revocation without altering accepted history (AE2)', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    const accepted = await service.send({ roomId: room.roomId, clientTxnId: 'c-5', content: text('before') });
    substrate.rooms.set(room.roomId, { ...room, membership: 'revoked' });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-6', content: text('after') })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-5', content: text('before') })).toEqual(accepted);
    substrate.rooms.set(room.roomId, { ...room, membership: 'left' });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-7', content: text('after') })).toEqual({ kind: 'rejected', code: 'not_joined' });
    expect(substrate.sendCalls.map(call => call.clientTxnId)).toEqual(['c-5']);
  });

  it('refuses to resend an unresolved transaction from another device', async () => {
    const { service, substrate, device } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = () => 'lose';
    await service.send({ roomId: room.roomId, clientTxnId: 'c-8', content: text('hi') });
    device.view = { ...device.view, deviceId: 'device-2' as DeviceId, generation: 2 };
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-8', content: text('hi') })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(substrate.sendCalls).toHaveLength(1);
  });

  it('treats a thrown SDK read as unavailable and sends nothing', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.readsThrow = true;
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-10', content: text('hi') })).toEqual({ kind: 'unavailable', retryable: true });
    expect(await service.timeline({ roomId: room.roomId, cursor: null, limit: 5 })).toEqual({ kind: 'unavailable', retryable: true });
    expect(substrate.sendCalls).toEqual([]);
  });

  it('rejects invalid content before any effect', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-9', content: text('x'.repeat(300)) })).toEqual({ kind: 'rejected', code: 'too_large' });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c-9', content: text('a\u0000') })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(substrate.sendCalls).toEqual([]);
  });
});
