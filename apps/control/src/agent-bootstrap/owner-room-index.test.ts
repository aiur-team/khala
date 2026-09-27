import { describe, expect, it } from 'vitest';
import type { RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../auth/support.test';
import { createOwnerRoomIndex } from './owner-room-index';

const roomId = '!room:example' as RoomId;
const binding = { v: 1, bindingId: 'binding-one', ownerId: 'owner-one', agentParticipantId: 'agent-one',
  deviceId: 'device-one', harness: 'claude', sessionId: 'session-one', generation: 0 } as SessionBinding;

describe('owner-room binding index', () => {
  it('atomically fences future activation and replays one close marker', async () => {
    const index = createOwnerRoomIndex(fakeStore(() => T0).store);
    expect((await index.activate(binding, roomId)).kind).toBe('ok');
    expect((await index.activate(binding, roomId)).kind).toBe('ok');
    const closed = await index.markClosing(binding.ownerId, roomId, 'close_operation_one', 0);
    expect(closed).toMatchObject({ kind: 'ok', value: { bindings: [{ bindingId: binding.bindingId, generation: 0 }],
      marker: { operationId: 'close_operation_one' } } });
    expect(await index.markClosing(binding.ownerId, roomId, 'close_operation_one', 0)).toEqual(closed);
    expect((await index.activate({ ...binding, bindingId: 'binding-two' } as SessionBinding, roomId)).kind).toBe('closed');
    expect((await index.markClosing(binding.ownerId, roomId, 'other_close_operation', 0)).kind).toBe('closed');
  });

  it('serializes activation against closure and never loses a running binding', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const index = createOwnerRoomIndex(fakeStore(() => T0).store);
      expect((await index.activate(binding, roomId)).kind).toBe('ok');
      const second = { ...binding, bindingId: 'binding-two' } as SessionBinding;
      const [activation, closure] = await Promise.all([
        index.activate(second, roomId), index.markClosing(binding.ownerId, roomId, 'close_operation_one', 0),
      ]);
      expect(closure.kind).toBe('ok');
      if (closure.kind !== 'ok') continue;
      const ids = closure.value.bindings.map(item => item.bindingId);
      expect(ids).toContain(binding.bindingId);
      if (activation.kind === 'ok') expect(ids).toContain(second.bindingId);
      else expect(activation.kind).toBe('closed');
    }
  });

  it('refuses to claim an old room with no authoritative index as safely empty', async () => {
    const index = createOwnerRoomIndex(fakeStore(() => T0).store);
    expect(await index.markClosing(binding.ownerId, roomId, 'close_operation_one', 0)).toEqual({ kind: 'unavailable' });
  });
});
