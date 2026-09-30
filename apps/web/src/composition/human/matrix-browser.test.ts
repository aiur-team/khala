import { describe, expect, it, vi } from 'vitest';
import { ClientEvent, EventType, MatrixEventEvent, Preset, Visibility, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { decodeContentLimits, type ParticipantView } from '@khala/contracts/messaging/index';
import { createMatrixRoomRequest, projectJoinedEncryptedRooms, projectMatrixTimelineEvent, startMatrixClient, subscribeConversationIndex, subscribeRoomDecryption } from './matrix-browser';

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

  it('republishes only the current room when an existing event decrypts after sync', () => {
    const listeners = new Map<string, (event: { getRoomId(): string }) => void>();
    const client = {
      on: vi.fn((kind: string, listener: (event: { getRoomId(): string }) => void) => listeners.set(kind, listener)),
      off: vi.fn((kind: string) => listeners.delete(kind)),
    } as unknown as MatrixClient;
    let current = true;
    const publish = vi.fn();
    const dispose = subscribeRoomDecryption(client, '!current:example.test' as never, () => current, publish);
    const decrypted = listeners.get(MatrixEventEvent.Decrypted);
    expect(decrypted).toBeDefined();
    decrypted!({ getRoomId: () => '!other:example.test' });
    expect(publish).not.toHaveBeenCalled();
    decrypted!({ getRoomId: () => '!current:example.test' });
    expect(publish).toHaveBeenCalledOnce();
    current = false;
    decrypted!({ getRoomId: () => '!current:example.test' });
    expect(publish).toHaveBeenCalledOnce();
    dispose();
    expect(listeners.has(MatrixEventEvent.Decrypted)).toBe(false);
  });

  it('retains an encrypted event identity until the same event decrypts', () => {
    const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('invalid test limits');
    const participant: ParticipantView = {
      participantId: 'participant_1' as never, kind: 'human', ownerId: 'owner_1' as never,
      displayName: 'Owner', deviceIds: [],
    };
    let decrypted = false;
    const event = {
      getId: () => '$same', getSender: () => '@owner:example.test', getTs: () => Date.parse('2026-09-29T23:00:00Z'),
      isDecryptionFailure: () => false,
      getType: () => decrypted ? EventType.RoomMessage : 'm.room.encrypted',
      getContent: () => decrypted ? { msgtype: 'm.text', body: 'Recovered text' } : {},
      getUnsigned: () => ({}),
    } as unknown as MatrixEvent;
    expect(projectMatrixTimelineEvent(event, participant, null, limits.value)).toMatchObject({
      kind: 'undecryptable', eventId: '$same', authorParticipantId: participant.participantId,
    });
    decrypted = true;
    expect(projectMatrixTimelineEvent(event, participant, 'DEVICE_1' as never, limits.value)).toMatchObject({
      kind: 'message', eventId: '$same', content: { body: 'Recovered text' },
    });
  });

  it.each(['agent_rename', 'agent_name_snapshot'] as const)('preserves %s metadata in the shared Matrix event projection', kind => {
    const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('invalid test limits');
    const participant: ParticipantView = { participantId: 'human_one' as never, ownerId: 'owner_one' as never,
      kind: 'human', displayName: 'Maya', deviceIds: [] };
    const event = { getId: () => '$name', getSender: () => '@maya:example.test', getTs: () => 0,
      isDecryptionFailure: () => false, getType: () => EventType.RoomMessage, getUnsigned: () => ({}),
      getContent: () => ({ msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': 'agent_one',
        ...(kind === 'agent_name_snapshot' ? { 'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': '$prior' } : {}) }),
    } as unknown as MatrixEvent;
    expect(projectMatrixTimelineEvent(event, participant, 'DEVICE_ONE' as never, limits.value)).toMatchObject({
      kind: 'message', content: { kind, agentParticipantId: 'agent_one', body: 'Dolan',
        ...(kind === 'agent_name_snapshot' ? { sourceEventId: '$prior' } : {}) },
    });
  });

});
