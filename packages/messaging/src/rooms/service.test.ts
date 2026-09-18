import { describe, expect, it } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { createMemoryRoomJournal, createRoomService } from './index';
import { FakeSubstrate, fakeDevice, harness, human, limits, principal, settle, text } from './fixtures/fakes';

describe('room service', () => {
  it('refuses an actor that does not belong to the authenticated owner', () => {
    expect(() => createRoomService({
      principal, actor: { ...human, ownerId: 'owner-2' as OwnerId }, device: fakeDevice(), substrate: new FakeSubstrate(),
      journal: createMemoryRoomJournal(), limits,
    })).toThrow(TypeError);
  });

  it('shares one substrate subscription per room and releases it with the last observer', () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    const first = service.observe(room.roomId, () => {});
    const second = service.observeEntries(room.roomId, () => {});
    expect(substrate.subscribers(room.roomId)).toBe(1);
    first();
    first();
    expect(substrate.subscribers(room.roomId)).toBe(1);
    second();
    expect(substrate.subscribers(room.roomId)).toBe(0);
  });

  it('stops every observation and refuses later commands', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    const seen: unknown[] = [];
    service.observe(room.roomId, snapshot => seen.push(snapshot));
    service.stop();
    expect(substrate.subscribers(room.roomId)).toBe(0);
    substrate.emit(room.roomId, { generation: 1, room, events: [] });
    await settle();
    expect(seen).toEqual([]);
    expect(service.observe(room.roomId, () => {})).toBeTypeOf('function');
    expect(substrate.subscribers(room.roomId)).toBe(0);
    expect(await service.create({ operationId: 'op', title: null })).toEqual({ kind: 'unavailable', retryable: true });
    expect(await service.send({ roomId: room.roomId, clientTxnId: 'c', content: text('x') })).toEqual({ kind: 'unavailable', retryable: true });
    expect(await service.timeline({ roomId: room.roomId, cursor: null, limit: 1 })).toEqual({ kind: 'unavailable', retryable: true });
  });

  it('carries a lost create through reconciliation into a named chat with an intro (AE2)', async () => {
    const { service, substrate } = harness();
    substrate.createMode = 'lose';
    expect(await service.create({ operationId: 'op-chat', title: 'Launch' })).toEqual({ kind: 'outcome_unknown', operationId: 'op-chat' });
    substrate.createMode = 'accept';
    const created = await service.create({ operationId: 'op-chat', title: 'Launch' });
    if (created.kind !== 'ok') throw new Error('expected the create to reconcile');
    expect(substrate.rooms.size).toBe(1);

    const intro = await service.prepareIntro({ roomId: created.value.roomId, batchId: 'intro', messages: [text('Hello'), text('Meet my agent')] });
    expect(intro).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'accepted' }] });
  });
});
