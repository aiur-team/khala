import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientEvent, EventType, MatrixEvent, MatrixEventEvent, Preset, RoomEvent, Visibility, type EventTimeline, type MatrixClient, type Room } from 'matrix-js-sdk';
import { DecryptionFailureCode, type CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import { decodeContentLimits, type MessageContent, type ParticipantView, type RoomId } from '@khala/contracts/messaging/index';
import { inviteWithHistory, createMatrixRoomRequest, ensureCrossSigning, isPreJoinUndecryptable, decryptTimelineEvents, paginateHistoricalEvents, projectJoinedEncryptedRooms, projectMatrixTimelineEvent, sendRoomMessage, startMatrixClient, subscribeConversationIndex, subscribeRoomDecryption } from './matrix-browser';

describe('Matrix browser safety boundaries', () => {
  it('attempts all initial ciphertext and keeps a failed event available for later key recovery', async () => {
    const encrypted = (id: string) => new MatrixEvent({
      event_id: id, room_id: '!room:example.test', sender: '@sender:example.test',
      type: 'm.room.encrypted', content: { algorithm: 'm.megolm.v1.aes-sha2' }, origin_server_ts: 1,
    });
    const first = encrypted('$first');
    const second = encrypted('$second');
    const decryptEvent = vi.fn(async (event: MatrixEvent) => {
      if (event === second) throw new Error('historical key unavailable');
      return { clearEvent: { type: EventType.RoomMessage, content: { body: 'First message', msgtype: 'm.text' } } };
    });
    const client = { decryptEventIfNeeded: vi.fn((event: MatrixEvent) =>
      event.attemptDecryption({ decryptEvent } as never)) } as unknown as MatrixClient;

    await expect(decryptTimelineEvents(client, [first, second])).resolves.toBeUndefined();
    expect(first.getType()).toBe(EventType.RoomMessage);
    expect(first.getContent().body).toBe('First message');
    expect(second.isDecryptionFailure()).toBe(true);
    expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
    await decryptTimelineEvents(client, [first, second]);
    expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(2);
    expect(decryptEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps a concurrent live arrival out of a backward history page', async () => {
    const event = (id: string) => new MatrixEvent({
      event_id: id, room_id: '!room:example.test', sender: '@sender:example.test',
      type: 'm.room.encrypted', content: {}, origin_server_ts: 1,
    });
    const old = event('$old');
    const anchor = event('$anchor');
    const live = event('$live');
    const events = [anchor];
    let receive: ((event: MatrixEvent, room: Room, toStart: boolean) => void) | undefined;
    const room = { roomId: '!room:example.test' } as Room;
    const timeline = { getEvents: () => events } as EventTimeline;
    const client = {
      on: vi.fn((kind: RoomEvent, callback: typeof receive) => { if (kind === RoomEvent.Timeline) receive = callback; }),
      off: vi.fn((kind: RoomEvent) => { if (kind === RoomEvent.Timeline) receive = undefined; }),
      paginateEventTimeline: vi.fn(async () => {
        events.push(live);
        receive?.(live, room, false);
        events.unshift(old);
        receive?.(old, room, true);
        return true;
      }),
    } as unknown as MatrixClient;

    const page = await paginateHistoricalEvents(client, timeline, room.roomId as never, 20);
    expect(page.events).toEqual([old]);
    expect(page.hasMore).toBe(true);
    expect(client.off).toHaveBeenCalledWith(RoomEvent.Timeline, expect.any(Function));
  });

  it('creates encrypted invite-only rooms', () => {
    const request = createMatrixRoomRequest({ operationId: 'create_1', title: 'Private room' });

    expect(request.initial_state).toContainEqual({ type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } });
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
      getMember: () => null,
      getMyMembership: () => membership,
      hasEncryptionStateEvent: () => encrypted,
      getLastLiveEvent: () => event,
      getUnreadNotificationCount: () => 0,
      getLiveTimeline: () => ({ getEvents: () => [event, new MatrixEvent({ event_id: '$channel-event', sender: '@agent:test',
        type: 'com.khala.event.v1', content: { v: 1, kind: 'deploy.finished', summary: 'deployed', body: 'deployed' },
        origin_server_ts: Date.parse('2026-10-01T00:00:00Z') })] }),
    }) as unknown as Room;
    const client = { getUserId: () => '@me:example.test', getRooms: () => [candidate('room_1', 'join', true), candidate('room_2', 'invite', true), candidate('room_3', 'join', false)] } as Pick<MatrixClient, 'getRooms' | 'getUserId'>;
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
      getMember: () => null, getMyMembership: () => 'join', hasEncryptionStateEvent: () => true,
      getLastLiveEvent: () => event, getUnreadNotificationCount: () => 1,
      getLiveTimeline: () => ({ getEvents: () => [event] }),
    } as unknown as Room;
    const client = {
      getUserId: () => '@me:example.test', getRooms: () => [room], on: vi.fn(), off: vi.fn(),
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

  it('drops a malformed notice target before participant target resolution', () => {
    const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('invalid test limits');
    const participant: ParticipantView = { participantId: 'human_one' as never, ownerId: 'owner_one' as never,
      kind: 'human', displayName: 'Maya', deviceIds: [] };
    const event = { getId: () => '$bad', getSender: () => '@maya:example.test', getTs: () => 0,
      isDecryptionFailure: () => false, getType: () => EventType.RoomMessage, getUnsigned: () => ({}),
      getContent: () => ({ msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': '' }),
    } as unknown as MatrixEvent;
    expect(projectMatrixTimelineEvent(event, participant, 'DEVICE_ONE' as never, limits.value)).toBeNull();
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

describe('plain encrypted channel send', () => {
  afterEach(() => vi.unstubAllGlobals());

  const input = {
    roomId: '!channel:example.test' as RoomId,
    clientTxnId: 'txn_1',
    content: { v: 1, kind: 'text', body: 'hello' } as MessageContent,
  };
  const clientFor = (room: Room | null = { hasEncryptionStateEvent: () => true } as Room) => ({
    getRoom: vi.fn(() => room),
    sendEvent: vi.fn(async () => ({ event_id: '$evt1' })),
    getDeviceId: vi.fn(() => 'KH_WEB_ONE'),
  }) as unknown as Pick<MatrixClient, 'getRoom' | 'sendEvent' | 'getDeviceId'>;

  it('sends once with the transaction ID and performs no control request', async () => {
    const fetch = vi.fn(() => { throw new Error('unexpected control request'); });
    vi.stubGlobal('fetch', fetch);
    const client = clientFor();
    await expect(sendRoomMessage(client, input)).resolves.toEqual({
      kind: 'done', value: { eventId: '$evt1', authorDeviceId: 'KH_WEB_ONE' },
    });
    expect(client.sendEvent).toHaveBeenCalledExactlyOnceWith(
      input.roomId, EventType.RoomMessage, { msgtype: 'm.text', body: 'hello' }, 'txn_1',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, { hasEncryptionStateEvent: () => false } as Room])('does not send without an encrypted channel (%s)', async room => {
    const client = clientFor(room);
    await expect(sendRoomMessage(client, input)).resolves.toEqual({ kind: 'unavailable' });
    expect(client.sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    [{ errcode: 'M_FORBIDDEN' }, { kind: 'rejected', code: 'forbidden' }],
    [{ httpStatus: 404 }, { kind: 'rejected', code: 'not_found' }],
    [new Error('network timeout'), { kind: 'unknown' }],
  ])('preserves send failure classification (%s)', async (error, result) => {
    const client = clientFor();
    vi.mocked(client.sendEvent).mockRejectedValueOnce(error);
    await expect(sendRoomMessage(client, input)).resolves.toEqual(result);
    expect(client.sendEvent).toHaveBeenCalledOnce();
  });

  it.each(['agent_rename', 'agent_name_snapshot'] as const)('retains the %s payload mapping', async kind => {
    const client = clientFor();
    const content = { v: 1, kind, body: 'Dolan', agentParticipantId: 'agent_one',
      ...(kind === 'agent_name_snapshot' ? { sourceEventId: '$prior' } : {}) } as MessageContent;
    await sendRoomMessage(client, { ...input, content });
    expect(client.sendEvent).toHaveBeenCalledExactlyOnceWith(input.roomId, EventType.RoomMessage, {
      msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': 'agent_one',
      ...(kind === 'agent_name_snapshot' ? { 'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': '$prior' } : {}),
    }, 'txn_1');
  });
});

describe('inviteWithHistory', () => {
  function client(encrypted = true, membership?: string) {
    return { getRoom: vi.fn(() => ({ hasEncryptionStateEvent: () => encrypted,
      getMember: () => membership ? { membership } : null } as unknown as Room)), invite: vi.fn().mockResolvedValue({}) };
  }
  it('uses the browser SDK invite for an encrypted channel', async () => {
    const sdk = client();
    expect(await inviteWithHistory(sdk, '!r', '@agent-x:hs')).toBe(true);
    expect(sdk.invite).toHaveBeenCalledExactlyOnceWith('!r', '@agent-x:hs');
  });
  it.each(['invite', 'join'])('skips a member already in state %s', async membership => {
    const sdk = client(true, membership);
    expect(await inviteWithHistory(sdk, '!r', '@agent-x:hs')).toBe(true);
    expect(sdk.invite).not.toHaveBeenCalled();
  });
  it('fails closed on unencrypted or missing channels and malformed identities', async () => {
    const sdk = client(false);
    expect(await inviteWithHistory(sdk, '!r', '@agent-x:hs')).toBe(false);
    const encrypted = client();
    for (const id of ['agent', '@:hs', '@a b:hs', '@a:']) expect(await inviteWithHistory(encrypted, '!r', id)).toBe(false);
    encrypted.getRoom.mockReturnValue(null as unknown as Room);
    expect(await inviteWithHistory(encrypted, '!r', '@agent-x:hs')).toBe(false);
    expect(sdk.invite).not.toHaveBeenCalled();
    expect(encrypted.invite).not.toHaveBeenCalled();
  });
  it('returns false when the invite fails', async () => {
    const sdk = client(); sdk.invite.mockRejectedValue(new Error('offline'));
    expect(await inviteWithHistory(sdk, '!r', '@agent-x:hs')).toBe(false);
  });
});

describe('channel event decoding', () => {
  const participant: ParticipantView = { participantId: 'agent_1' as never, ownerId: 'owner_1' as never,
    kind: 'agent', displayName: 'Claude · Kevin', deviceIds: [] };
  const limits = decodeContentLimits({ maxBodyBytes: 32768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
  if (!limits.ok) throw new Error('invalid limits');
  const content = { v: 1, body: 'review requested', kind: 'pr.ready_for_review', summary: 'review requested' };
  function event(raw: object) {
    return new MatrixEvent({ event_id: '$event', sender: '@agent:test', room_id: '!room:test',
      origin_server_ts: Date.parse('2026-10-01T10:09:30Z'), type: 'com.khala.event.v1', content: raw });
  }
  it('decodes without message device attribution', () => {
    expect(projectMatrixTimelineEvent(event(content), participant, null, limits.value)).toEqual({
      kind: 'channel_event', eventId: '$event', participant, content, receivedAt: '2026-10-01T10:09:30.000Z',
    });
  });
  it.each([{ ...content, url: 'javascript:alert(1)' }, { ...content, summary: '' }, {}])('drops malformed content %j', raw => {
    expect(projectMatrixTimelineEvent(event(raw), participant, null, limits.value)).toBeNull();
  });
});

describe('browser cross-signing and shared history', () => {
  afterEach(() => vi.useRealTimers());
  const cryptoMock = (cached = false, server = false) => ({
    getCrossSigningStatus: vi.fn(async () => ({ privateKeysCachedLocally: { masterKey: cached, selfSigningKey: cached, userSigningKey: cached } })),
    userHasCrossSigningKeys: vi.fn(async () => server),
    bootstrapCrossSigning: vi.fn<CryptoApi['bootstrapCrossSigning']>(async () => {}),
  });
  it('keeps locally cached signing keys', async () => {
    const crypto = cryptoMock(true);
    expect(await ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test')).toBe('present');
    expect(crypto.userHasCrossSigningKeys).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });
  it('never resets an identity held by another device', async () => {
    const crypto = cryptoMock(false, true);
    expect(await ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test')).toBe('foreign');
    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith('@me:test', true);
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });
  it('bootstraps the first identity with no UIA', async () => {
    const crypto = cryptoMock();
    expect(await ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test')).toBe('bootstrapped');
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce();
    const upload = vi.fn(async () => {});
    await crypto.bootstrapCrossSigning.mock.calls[0]![0]!.authUploadDeviceSigningKeys!(upload);
    expect(upload).toHaveBeenCalledWith(null);
  });
  it.each(['getCrossSigningStatus', 'userHasCrossSigningKeys', 'bootstrapCrossSigning'] as const)('swallows %s failures', async method => {
    const crypto = cryptoMock();
    crypto[method].mockRejectedValueOnce(new Error('offline'));
    expect(await ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test')).toBe('failed');
  });
  it.each(['getCrossSigningStatus', 'userHasCrossSigningKeys', 'bootstrapCrossSigning'] as const)('bounds a hanging %s', async method => {
    vi.useFakeTimers();
    const crypto = cryptoMock();
    crypto[method].mockImplementationOnce(() => new Promise(() => {}) as never);
    const attempt = ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await attempt).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not bootstrap when a server lookup completes after the deadline', async () => {
    vi.useFakeTimers();
    const crypto = cryptoMock();
    let resolve!: (exists: boolean) => void;
    crypto.userHasCrossSigningKeys.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    const attempt = ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await attempt).toBe('failed');
    resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });
  it('stops maintenance when the device generation closes', async () => {
    vi.useFakeTimers();
    const crypto = cryptoMock();
    crypto.getCrossSigningStatus.mockImplementationOnce(() => new Promise(() => {}));
    const abort = new AbortController();
    const attempt = ensureCrossSigning(crypto as unknown as CryptoApi, '@me:test', abort.signal);
    abort.abort();
    expect(await attempt).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });
  it.each([
    [true, 'm.room.encrypted', 900, null, 1000, true],
    [true, 'm.room.encrypted', 950, DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED, null, true],
    [true, 'm.room.encrypted', 1100, null, 1000, false],
    [true, 'm.room.encrypted', 1000, null, 1000, false],
    [false, EventType.RoomMessage, 900, null, 1000, false],
    [false, 'm.room.encrypted', 900, null, null, false],
  ])('filters only pre-join undecryptable events (%s, %s, %s)', (failed, type, ts, reason, joinTs, expected) => {
    const event = { isDecryptionFailure: () => failed, getType: () => type, getTs: () => ts, decryptionFailureReason: reason } as unknown as MatrixEvent;
    expect(isPreJoinUndecryptable(event, joinTs as number | null)).toBe(expected);
  });
  it('omits pre-join ciphertext from conversation previews', () => {
    const limits = decodeContentLimits({ maxBodyBytes: 32768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('invalid limits');
    const event = new MatrixEvent({ event_id: '$old', type: 'm.room.encrypted', content: {}, origin_server_ts: 900 });
    const room = { roomId: '!room:test', name: 'Room', getMyMembership: () => 'join', hasEncryptionStateEvent: () => true,
      getMember: () => ({ membership: 'join', events: { member: { getTs: () => 1000 } } }),
      getLastLiveEvent: () => event, getUnreadNotificationCount: () => 0, getLiveTimeline: () => ({ getEvents: () => [event] }),
    } as unknown as Room;
    expect(projectJoinedEncryptedRooms({ getRooms: () => [room], getUserId: () => '@me:test' }, limits.value)[0])
      .toMatchObject({ preview: null, timestamp: null });
  });
});
