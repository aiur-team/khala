import { describe, expect, it, vi } from 'vitest';
import { ClientEvent, EventType, MatrixEventEvent, Preset, Visibility, type MatrixClient, type Room } from 'matrix-js-sdk';
import { decodeContentLimits } from '@khala/contracts/messaging/index';
import { createMatrixRoomRequest, projectJoinedEncryptedRooms, startMatrixClient, subscribeConversationIndex } from './matrix-browser';

describe('Matrix browser safety boundaries', () => {
  it('creates encrypted invite-only rooms', () => {
    const request = createMatrixRoomRequest({ operationId: 'create_1', title: 'Private room' });

    expect(request.visibility).toBe(Visibility.Private);
    expect(request.preset).toBe(Preset.PrivateChat);
    expect(request.initial_state).toContainEqual({
      type: EventType.RoomEncryption,
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    });
  });

  it('stops a client whose initial sync fails', async () => {
    const stopClient = vi.fn();
    const listeners = new Map<string, (...args: never[]) => void>();
    const client = {
      on: vi.fn((event: string, listener: (...args: never[]) => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
      startClient: vi.fn(async () => { throw new Error('sync failed'); }),
      stopClient,
    } as unknown as MatrixClient;

    await expect(startMatrixClient(client, new AbortController().signal)).rejects.toThrow('sync failed');
    expect(client.on).toHaveBeenCalledWith(ClientEvent.Sync, expect.any(Function));
    expect(stopClient).toHaveBeenCalledOnce();
  });

  it('indexes only joined encrypted rooms and previews decrypted text', () => {
    const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('invalid test limits');
    const event = {
      getType: () => EventType.RoomMessage,
      isDecryptionFailure: () => false,
      getClearContent: () => ({ body: 'Verified plaintext' }),
      getContent: () => ({ body: 'Verified plaintext', msgtype: 'm.text' }),
      getTs: () => Date.parse('2026-09-28T12:00:00.000Z'),
      getId: () => '$event',
    };
    const candidate = (id: string, membership: string, encrypted: boolean) => ({
      roomId: id, name: `Title ${id}`,
      getMyMembership: () => membership,
      hasEncryptionStateEvent: () => encrypted,
      getLastLiveEvent: () => event,
      getUnreadNotificationCount: () => 0,
      getLiveTimeline: () => ({ getEvents: () => [event] }),
    }) as unknown as Room;
    const client = { getRooms: () => [candidate('room_1', 'join', true), candidate('room_2', 'invite', true), candidate('room_3', 'join', false)] } as Pick<MatrixClient, 'getRooms'>;
    expect(projectJoinedEncryptedRooms(client, limits.value)).toEqual([{
      id: 'room_1', title: 'Title room_1', preview: 'Verified plaintext', timestamp: '2026-09-28T12:00:00.000Z', unreadCount: null,
    }]);
  });

  it('refreshes a late decrypted preview without another sync and fences old generations', () => {
    const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('invalid test limits');
    let decrypted = false;
    let current = true;
    const decryptListeners = new Set<() => void>();
    const event = {
      getType: () => decrypted ? EventType.RoomMessage : 'm.room.encrypted',
      isDecryptionFailure: () => false,
      getClearContent: () => decrypted ? { body: 'Recovered plaintext' } : {},
      getContent: () => decrypted ? { body: 'Recovered plaintext', msgtype: 'm.text' } : {},
      getTs: () => Date.parse('2026-09-28T12:00:00.000Z'),
      getId: () => '$late',
      on: vi.fn((kind: string, callback: () => void) => { if (kind === MatrixEventEvent.Decrypted) decryptListeners.add(callback); }),
      off: vi.fn((kind: string, callback: () => void) => { if (kind === MatrixEventEvent.Decrypted) decryptListeners.delete(callback); }),
    };
    const room = {
      roomId: 'room_1', name: 'Recovered channel',
      getMyMembership: () => 'join', hasEncryptionStateEvent: () => true,
      getLastLiveEvent: () => event, getUnreadNotificationCount: () => 1,
      getLiveTimeline: () => ({ getEvents: () => [event] }),
    } as unknown as Room;
    const client = {
      getRooms: () => [room], on: vi.fn(), off: vi.fn(),
    } as unknown as MatrixClient;
    const notify = vi.fn();
    const dispose = subscribeConversationIndex(client, () => current, notify);
    expect(projectJoinedEncryptedRooms(client, limits.value)[0]).toMatchObject({
      preview: null, timestamp: '2026-09-28T12:00:00.000Z',
    });
    expect(decryptListeners.size).toBe(1);
    notify.mockClear();
    decrypted = true;
    for (const callback of decryptListeners) callback();
    expect(notify).toHaveBeenCalledOnce();
    expect(projectJoinedEncryptedRooms(client, limits.value)[0]).toMatchObject({
      preview: 'Recovered plaintext', timestamp: '2026-09-28T12:00:00.000Z', unreadCount: 1,
    });
    current = false;
    for (const callback of decryptListeners) callback();
    expect(notify).toHaveBeenCalledOnce();
    dispose();
    expect(decryptListeners.size).toBe(0);
  });
});
