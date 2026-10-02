import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { createClient, ClientEvent, RoomEvent, MatrixEventEvent, SyncState, Direction, Method } from 'matrix-js-sdk';
import type { MatrixEvent, Room, IRoomTimelineData } from 'matrix-js-sdk';

export type SessionMessage = { eventId: string; roomId: string; sender: string; ts: number; type: 'm.room.message' | 'com.khala.event.v1'; body: string; content: Record<string, unknown> };
export interface AgentMatrixSession {
  readonly userId: string;
  onMessage(handler: (m: SessionMessage) => void): () => void;
  waitForInvite(roomId: string, timeoutMs: number): Promise<void>;
  join(roomId: string): Promise<void>;
  history(roomId: string, limit: number, before?: string): Promise<{ messages: SessionMessage[]; nextBefore?: string }>;
  send(roomId: string, text: string): Promise<{ eventId: string }>;
  sendChannelEvent(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<{ eventId: string }>;
  roomName(roomId: string): string | undefined;
  displayName(userId: string): string | undefined;
  stop(): Promise<void>;
}

function message(event: MatrixEvent): SessionMessage | undefined {
  const type = event.getType();
  const eventId = event.getId();
  const roomId = event.getRoomId();
  const sender = event.getSender();
  if (event.isDecryptionFailure() || !eventId || !roomId || !sender || (type !== 'm.room.message' && type !== 'com.khala.event.v1')) return;
  const content = event.getContent();
  return { eventId, roomId, sender, ts: event.getTs(), type, body: typeof content.body === 'string' ? content.body : '', content };
}

export async function createAgentMatrixSession(creds: AgentCredentials, opts?: { log?: (line: string) => void }): Promise<AgentMatrixSession> {
  const started = Date.now();
  const log = (line: string) => opts?.log?.(line);
  const client = createClient({ baseUrl: creds.homeserver, userId: creds.userId, accessToken: creds.accessToken, deviceId: creds.deviceId });
  const handlers = new Set<(m: SessionMessage) => void>();
  const emitted = new Set<string>();
  // Only events originating in a live timeline may later be emitted by Decrypted.
  const liveEvents = new Set<MatrixEvent>();
  const joinTimes = new Map<string, number>();
  const cancellations = new Set<() => void>();
  let joinedRoom: string | undefined;
  let stopped = false;

  const deliver = (event: MatrixEvent) => {
    if (stopped || !liveEvents.has(event)) return;
    const m = message(event);
    if (!m) {
      if (event.getType() !== 'm.room.encrypted' && !event.isDecryptionFailure()) liveEvents.delete(event);
      return;
    }
    const cutoff = joinTimes.get(m.roomId);
    if (cutoff === undefined) return; // Rechecked after the join state is stored.
    if (m.sender === creds.userId || m.ts < cutoff || client.getRoom(m.roomId)?.getMyMembership() !== 'join') {
      liveEvents.delete(event);
      return;
    }
    liveEvents.delete(event);
    if (emitted.has(m.eventId)) return;
    emitted.add(m.eventId);
    for (const handler of handlers) {
      try { handler(m); } catch { log('message_handler_error'); }
    }
  };
  const timeline = (event: MatrixEvent, _room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: IRoomTimelineData) => {
    if (stopped || toStart || data?.liveEvent === false) return;
    liveEvents.add(event);
    void client.decryptEventIfNeeded(event).then(() => deliver(event), () => log('live_decryption_failed'));
  };
  const decrypted = (event: MatrixEvent) => deliver(event);
  const syncLog = (state: SyncState) => log(`sync_state=${state}`);

  // All waits are cancellable so stop never leaves timers or listeners behind.
  const wait = (subscribe: (check: () => void) => () => void, ready: () => boolean, timeoutMs: number, error: string): Promise<void> => {
    if (stopped) return Promise.reject(new Error('session_stopped'));
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (failure?: string) => {
        clearTimeout(timer);
        unsubscribe();
        cancellations.delete(cancel);
        if (failure) reject(new Error(failure)); else resolve();
      };
      const cancel = () => finish('session_stopped');
      const check = () => { if (ready()) finish(); };
      const timer = setTimeout(() => finish(error), timeoutMs);
      cancellations.add(cancel);
      unsubscribe = subscribe(check);
      check();
    });
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    client.stopClient();
    client.removeListener(RoomEvent.Timeline, timeline);
    client.removeListener(MatrixEventEvent.Decrypted, decrypted);
    client.removeListener(ClientEvent.Sync, syncLog);
    for (const cancel of [...cancellations]) cancel();
    liveEvents.clear();
    emitted.clear();
    handlers.clear();
  };
  try {
    await client.initRustCrypto({ useIndexedDB: false });
    const crypto = client.getCrypto();
    if (!crypto) throw new Error('crypto_unavailable');
    log(`crypto_version=${crypto.getVersion()}`);
    let outcome: string;
    if (await crypto.isCrossSigningReady()) outcome = 'already_ready';
    else if (await crypto.userHasCrossSigningKeys(creds.userId, true)) outcome = 'unavailable_existing_identity';
    else {
      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (f) => { await f(null); } });
      if (!await crypto.isCrossSigningReady()) throw new Error('cross_signing_failed');
      outcome = 'bootstrapped';
    }
    log(`cross_signing=${outcome}`);
    client.on(RoomEvent.Timeline, timeline);
    client.on(MatrixEventEvent.Decrypted, decrypted);
    client.on(ClientEvent.Sync, syncLog);
    const prepared = wait((check) => {
      client.on(ClientEvent.Sync, check);
      return () => { client.removeListener(ClientEvent.Sync, check); };
    }, () => client.getSyncState() === SyncState.Prepared || client.getSyncState() === SyncState.Syncing, 30_000, 'sync_timeout');
    // startClient itself is async; attach its rejection to the awaited promise.
    await Promise.all([client.startClient({ initialSyncLimit: 30 }), prepared]);
    log(`session_ready_ms=${Date.now() - started}`);
  } catch (error) {
    await stop();
    throw error;
  }

  const membershipWait = (roomId: string, ready: () => boolean, timeoutMs: number, error: string) => wait((check) => {
    const listener = (room: Room) => { if (room.roomId === roomId) check(); };
    client.on(RoomEvent.MyMembership, listener);
    // New-room membership is emitted before the SDK stores the room.
    client.on(ClientEvent.Room, listener);
    return () => { client.removeListener(RoomEvent.MyMembership, listener); client.removeListener(ClientEvent.Room, listener); };
  }, ready, timeoutMs, error);

  return {
    userId: creds.userId,
    onMessage(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    waitForInvite(roomId, timeoutMs) {
      return membershipWait(roomId, () => ['invite', 'join'].includes(client.getRoom(roomId)?.getMyMembership() ?? ''), timeoutMs, 'invite_timeout');
    },
    async join(roomId) {
      if (stopped) throw new Error('session_stopped');
      const membership = client.getRoom(roomId)?.getMyMembership();
      if (membership !== 'join') {
        if (membership !== 'invite') throw new Error('not_invited');
        await client.joinRoom(roomId);
      }
      await membershipWait(roomId, () => client.getRoom(roomId)?.getMyMembership() === 'join', 30_000, 'join_timeout');
      const ownJoin = client.getRoom(roomId)?.currentState.getStateEvents('m.room.member', creds.userId);
      if (!ownJoin || ownJoin.getContent().membership !== 'join') throw new Error('join_state_unavailable');
      joinTimes.set(roomId, ownJoin.getTs());
      joinedRoom = roomId;
      for (const event of liveEvents) { if (event.getRoomId() === roomId) deliver(event); }
    },
    async history(roomId, limit, before) {
      let token: string | null = null;
      if (before !== undefined) {
        const context = await client.http.authedRequest<{ start: string }>(Method.Get, `/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(before)}`, { limit: '0' });
        token = context.start;
      }
      const res = await client.createMessagesRequest(roomId, token, limit, Direction.Backward);
      const messages: SessionMessage[] = [];
      let undecryptable = 0;
      for (const raw of res.chunk) {
        const event = client.getEventMapper()({ ...raw, room_id: roomId });
        try { await client.decryptEventIfNeeded(event); } catch { /* Report and omit below. */ }
        if (event.getType() === 'm.room.encrypted' || event.isDecryptionFailure()) { undecryptable++; continue; }
        const m = message(event);
        if (m && m.eventId !== before) messages.push(m);
      }
      log(`history_undecryptable=${undecryptable}`);
      messages.reverse();
      const oldest = messages[0];
      return typeof res.end === 'string' && oldest ? { messages, nextBefore: oldest.eventId } : { messages };
    },
    async send(roomId, text) { const res = await client.sendTextMessage(roomId, text); return { eventId: res.event_id }; },
    async sendChannelEvent() { throw new Error('not_implemented'); },
    roomName(roomId) { return client.getRoom(roomId)?.name ?? undefined; },
    displayName(userId) {
      const value = joinedRoom && client.getRoom(joinedRoom)?.currentState.getStateEvents('m.room.member', userId)?.getContent().displayname;
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
    stop,
  };
}
