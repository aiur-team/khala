import { retryUnexpired } from './decryption-retry';
import { LISTENING_MODE_COMMAND_TYPE, LISTENING_MODE_MEMBER_KEY, memberListeningMode } from '@khala/contracts/m1/listening-mode';
import { encodeChannelEvent, CHANNEL_EVENT_TYPE } from '@khala/contracts/m1/channel-event';
import { RESTORE_HISTORY_MAX_PAGES, type ChannelSession, type SessionEndReason, type SessionMessage, type SessionModeCommand, type SessionOptions } from '../transport';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { randomUUID } from 'node:crypto';
import { StateError } from '../state';
import { memberRenameContent } from '../events/member-rename';
import { createClient, ClientEvent, RoomEvent, MatrixEventEvent, SyncState, Direction, Method, EventType } from 'matrix-js-sdk';
import type { MatrixEvent, Room, IRoomTimelineData } from 'matrix-js-sdk';

export type { SessionMessage, SessionModeCommand } from '../transport';
export type AgentMatrixSession = ChannelSession;

function message(event: MatrixEvent): SessionMessage | undefined {
  const type = event.getType();
  const eventId = event.getId();
  const roomId = event.getRoomId();
  const sender = event.getSender();
  if (event.isDecryptionFailure() || !eventId || !roomId || !sender || (type !== 'm.room.message' && type !== 'com.khala.event.v1' && type !== 'm.room.member')) return;
  const content = event.getContent();
  if (type === 'm.room.member' && !memberRenameContent(content, event.getPrevContent())) return;
  return { eventId, roomId, sender, ts: event.getTs(), type, body: typeof content.body === 'string' ? content.body : '', content,
    ...(type === 'm.room.member' ? { previousContent: event.getPrevContent() } : {}) };
}

export async function createAgentMatrixSession(creds: AgentCredentials, opts?: SessionOptions & { log?: (line: string) => void }): Promise<AgentMatrixSession> {
  const started = Date.now();
  const rejoinTxnId = `khala.rejoin.${randomUUID()}`;
  const log = (line: string) => opts?.log?.(line);
  const persistent = opts?.cryptoStore ? await (await import('./crypto-store')).openCryptoStore(opts.cryptoStore.dir, opts.cryptoStore.root, creds) : undefined;
  const client = createClient({ ...(persistent ? { store: persistent.sync } : {}), baseUrl: creds.homeserver, userId: creds.userId, accessToken: creds.accessToken, deviceId: creds.deviceId });
  const handlers = new Set<(m: SessionMessage) => void>();
  const ended = new Set<(reason: SessionEndReason) => void>();
  const modeHandlers = new Set<(c: SessionModeCommand) => void>();
  const inviters = new Map<string, string>();
  const emitted = new Set<string>();
  // Only events originating in a live timeline may later be emitted by Decrypted.
  const liveEvents = new Set<MatrixEvent>();
  const undecryptableIds = new Map((persistent?.undecryptableEventIds ?? []).map(entry => [entry.id, entry]));
  let retrySave = Promise.resolve();
  const saveRetries = () => {
    const entries = [...undecryptableIds.values()];
    retrySave = retrySave.then(() => persistent?.rememberUndecryptable(entries)).catch(() => log('decryption_retry_save_failed'));
  };
  const rememberDecryption = (event: MatrixEvent) => {
    const id = event.getId();
    if (stopped || !persistent || !id) return;
    const failed = event.getType() === 'm.room.encrypted' || event.isDecryptionFailure();
    if (failed) { if (undecryptableIds.has(id)) return; undecryptableIds.set(id, { id, firstSeen: Date.now() }); } else if (!undecryptableIds.delete(id)) return;
    if (undecryptableIds.size > 100) undecryptableIds.delete(undecryptableIds.keys().next().value!);
    saveRetries();
  };
  const joinTimes = new Map<string, number>();
  const cancellations = new Set<() => void>();
  let joinedRoom: string | undefined;
  let stopped = false;
  let recovering = persistent?.restored ?? false;

  const deliver = (event: MatrixEvent) => {
    if (stopped) return;
    if (liveEvents.has(event)) rememberDecryption(event);
    if (recovering || !liveEvents.has(event)) return;
    const command = event.getType() === LISTENING_MODE_COMMAND_TYPE && !event.isDecryptionFailure()
      && event.getId() && event.getRoomId() && event.getSender()
      ? { eventId: event.getId()!, roomId: event.getRoomId()!, sender: event.getSender()!, ts: event.getTs(), content: event.getContent() } : undefined;
    const m = command ?? message(event);
    if (!m) {
      if (event.getType() !== 'm.room.encrypted' && !event.isDecryptionFailure()) liveEvents.delete(event);
      return;
    }
    const cutoff = joinTimes.get(m.roomId);
    if (cutoff === undefined) return; // Rechecked after the join state is stored.
    if ((m.sender === creds.userId && event.getType() !== 'm.room.member') || m.ts < cutoff || client.getRoom(m.roomId)?.getMyMembership() !== 'join') {
      liveEvents.delete(event);
      return;
    }
    liveEvents.delete(event);
    if (emitted.has(m.eventId)) return;
    emitted.add(m.eventId);
    if (command) {
      for (const handler of modeHandlers) {
        try { handler(command); } catch { log('mode_handler_error'); }
      }
    } else {
      const entry = message(event)!;
      for (const handler of handlers) {
        try { handler(entry); } catch { log('message_handler_error'); }
      }
    }
  };
  const timeline = (event: MatrixEvent, _room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: IRoomTimelineData) => {
    if (stopped || toStart || (data?.liveEvent === false && !persistent?.restored)) return;
    liveEvents.add(event);
    void client.decryptEventIfNeeded(event).then(() => deliver(event), () => { rememberDecryption(event); log('live_decryption_failed'); });
  };
  const decrypted = (event: MatrixEvent) => deliver(event);
  const syncLog = (state: SyncState, _previous: SyncState | null, data?: { error?: Error }) => {
    log(`sync_state=${state}`);
    if (state === SyncState.Error && joinedRoom && matrixCode(data?.error) === 'M_UNKNOWN_TOKEN') {
      void checkEnded('unauthorized');
    }
  };
  const matrixCode = (error: unknown): unknown => typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : undefined;
  let checkingEnded: Promise<void> | undefined;
  let pendingEndReason: SessionEndReason | undefined;
  const checkEnded = (fallback?: SessionEndReason): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (fallback) pendingEndReason = fallback;
    if (checkingEnded) return checkingEnded;
    checkingEnded = (async () => {
      let removed = false;
      try { removed = await opts?.checkRemoved?.() ?? false; } catch { /* Unavailable is not proof of removal. */ }
      if (removed) end('removed'); else if (pendingEndReason) end(pendingEndReason);
    })().finally(() => { checkingEnded = undefined; pendingEndReason = undefined; });
    return checkingEnded;
  };
  const guarded = async <T>(roomId: string, operation: () => Promise<T>): Promise<T> => {
    if (stopped) throw new Error('session_stopped');
    try { return await operation(); } catch (error) {
      const code = matrixCode(error);
      if (roomId === joinedRoom && (code === 'M_FORBIDDEN' || code === 'M_UNKNOWN_TOKEN')) {
        await checkEnded(code === 'M_UNKNOWN_TOKEN' ? 'unauthorized' : undefined);
      }
      throw error;
    }
  };

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
  let stopping: Promise<void> | undefined;
  let wipe = false;
  const stop = (): Promise<void> => stopping ??= stopSession();
  const stopSession = async () => {
    if (stopped) return;
    stopped = true;
    await retrySave;
    if (wipe) {
      // Retire the device while its token is still available. A failed/offline
      // logout must not prevent local cleanup or release of the store lease.
      try { await client.http.authedRequest(Method.Post, '/logout', undefined, {}, { localTimeoutMs: 5000 }); }
      catch (error) {
        if (matrixCode(error) !== 'M_UNKNOWN_TOKEN' && !(typeof error === 'object' && error !== null && 'httpStatus' in error && error.httpStatus === 401)) {
          log('discarded_device_logout_failed'); console.error('khala: discarded_device_logout_failed');
        }
      }
    }
    if (wipe && persistent?.forgetIdentity) {
      // Still stop the client and release its lease if the filesystem refuses
      // this first attempt. wipe retries deletion after the sync has drained.
      try { await persistent.forgetIdentity(); } catch { log('crypto_cleanup_failed'); }
    }
    // stopClient only aborts the HTTP request; STOPPED is emitted after the
    // current sync response and its store save have actually finished.
    let syncStopped: Promise<void> | undefined;
    if (persistent && client.getSyncState() !== null && client.getSyncState() !== SyncState.Stopped) {
      syncStopped = new Promise<void>((resolve, reject) => {
        const done = (state: SyncState) => { if (state === SyncState.Stopped) finish(); };
        const timer = setTimeout(() => finish(new Error('crypto_sync_stop_timeout')), 10_000);
        const finish = (error?: Error) => {
          clearTimeout(timer); client.removeListener(ClientEvent.Sync, done);
          if (error) reject(error); else resolve();
        };
        client.on(ClientEvent.Sync, done);
      });
    }
    client.stopClient();
    client.removeListener(RoomEvent.Timeline, timeline);
    client.removeListener(MatrixEventEvent.Decrypted, decrypted);
    client.removeListener(ClientEvent.Sync, syncLog);
    client.removeListener(RoomEvent.MyMembership, membershipEnded);
    for (const cancel of [...cancellations]) cancel();
    liveEvents.clear();
    emitted.clear();
    handlers.clear();
    modeHandlers.clear();
    ended.clear();
    if (persistent) {
      try { await syncStopped; if (wipe) await persistent.wipe(); } finally { await persistent.close(); }
    }
  };
  const membershipEnded = (room: Room, membership: string) => {
    if (stopped || room.roomId !== joinedRoom || !['leave', 'ban'].includes(membership)) return;
    end('removed');
  };
  const end = (reason: SessionEndReason) => {
    if (stopped) return;
    const listeners = [...ended];
    wipe = true;
    void stop().catch(() => { log('crypto_cleanup_failed'); console.error('khala: crypto_cleanup_failed'); });
    for (const handler of listeners) {
      try { handler(reason); } catch { log('ended_handler_error'); }
    }
  };
  try {
    if (persistent) await persistent.sync.startup();
    try {
      await client.initRustCrypto(persistent ? { useIndexedDB: true, cryptoDatabasePrefix: persistent.prefix } : { useIndexedDB: false });
    } catch (error) {
      if (!persistent?.restored || (error instanceof StateError && error.code === 'unsafe_state_dir')) throw error;
      // Never attach a new key store to the old device. The caller can make one
      // bounded retry using the replacement credentials authorized by control.
      // Close and release the store, but keep its identity until the caller
      // logs out the old device and wipes it before starting a replacement.
      throw new (await import('./crypto-store')).CryptoStoreCorruptError();
    }
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
    ...(persistent?.recovered ? { cryptoReset: true } : {}),
    ...(persistent?.restored ? { recoversOnJoin: true } : {}),
    onEnded(handler) { if (!stopped) ended.add(handler); return () => { ended.delete(handler); }; },
    listeningMode: roomId => memberListeningMode(client.getRoom(roomId)?.currentState.getStateEvents('m.room.member', creds.userId)?.getContent()),
    inviter(roomId) { return inviters.get(roomId); },
    onListeningModeCommand(handler) { modeHandlers.add(handler); return () => { modeHandlers.delete(handler); }; },
    async publishListeningMode(roomId, mode, signal) {
      if (stopped) throw new Error('session_stopped');
      const content = client.getRoom(roomId)?.currentState.getStateEvents('m.room.member', creds.userId)?.getContent();
      if (!content) throw new Error('join_state_unavailable');
      const next = { ...content, membership: 'join' as const, [LISTENING_MODE_MEMBER_KEY]: mode };
      await client.sendStateEvent(roomId, EventType.RoomMember, next, creds.userId, { localTimeoutMs: 5000, ...(signal ? { abortSignal: signal } : {}) });
    },
    onMessage(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    waitForInvite(roomId, timeoutMs) {
      return membershipWait(roomId, () => ['invite', 'join'].includes(client.getRoom(roomId)?.getMyMembership() ?? ''), timeoutMs, 'invite_timeout');
    },
    async join(roomId) {
      if (stopped) throw new Error('session_stopped');
      if (joinedRoom === roomId) return;
      const membership = client.getRoom(roomId)?.getMyMembership();
      if (membership !== 'join') {
        if (membership !== 'invite') throw new Error('not_invited');
        const inviter = client.getRoom(roomId)?.currentState.getStateEvents('m.room.member', creds.userId)?.getSender();
        if (inviter) inviters.set(roomId, inviter);
        await client.joinRoom(roomId);
      }
      await membershipWait(roomId, () => client.getRoom(roomId)?.getMyMembership() === 'join', 30_000, 'join_timeout');
      const ownJoin = client.getRoom(roomId)?.currentState.getStateEvents('m.room.member', creds.userId);
      if (!ownJoin || ownJoin.getContent().membership !== 'join') throw new Error('join_state_unavailable');
      if (membership === 'join') {
        const owner = ownJoin.getContent()['com.khala.invited_by'];
        if (typeof owner === 'string') inviters.set(roomId, owner);
        const event = encodeChannelEvent({ kind: 'member', summary: `${ownJoin.getContent().displayname ?? creds.userId} rejoined`, status: 'info', source: { system: 'khala-agent' } });
        if (event.ok) await client.sendEvent(roomId, CHANNEL_EVENT_TYPE as never, event.value as never, rejoinTxnId);
      }
      if (membership !== 'join' && inviters.has(roomId)) {
        const content = { ...ownJoin.getContent(), membership: 'join' as const, 'com.khala.invited_by': inviters.get(roomId) };
        await client.sendStateEvent(roomId, EventType.RoomMember, content, creds.userId);
      }
      const joinedAt = persistent?.joinedAt ?? ownJoin.getTs();
      await persistent?.rememberJoin(joinedAt);
      joinTimes.set(roomId, joinedAt);
      if (persistent?.restored) {
        // A limited /sync can omit an offline command. Replay to the durable
        // inbox tail, falling back to the original join when it is unavailable.
        // Inbox IDs and command metadata keep saved-sync replay idempotent.
        let pruned = false;
        for (const [id, entry] of [...undecryptableIds]) {
          if (stopped) throw new Error('session_stopped');
          if (!retryUnexpired(entry)) { undecryptableIds.delete(id); pruned = true; continue; }
          try {
            const raw = await client.fetchRoomEvent(roomId, id);
            const event = client.getEventMapper()({ ...raw, room_id: roomId });
            if (event.getTs() < joinedAt) { undecryptableIds.delete(id); pruned = true; continue; }
            liveEvents.add(event);
            await client.decryptEventIfNeeded(event).catch(() => log('recovery_decryption_failed'));
            rememberDecryption(event);
          } catch (error) {
            const status = typeof error === 'object' && error !== null && 'httpStatus' in error ? error.httpStatus : undefined;
            if (matrixCode(error) === 'M_NOT_FOUND' || matrixCode(error) === 'M_FORBIDDEN' || status === 404 || status === 403) {
              undecryptableIds.delete(id); pruned = true;
            }
            log('recovery_event_retry_failed');
          }
        }
        if (pruned) saveRetries();
        let token: string | null = null;
        const seenTokens = new Set<string>();
        let pages = 0;
        let undecryptable = 0;
        for (;;) {
          if (stopped) throw new Error('session_stopped');
          const page = await client.createMessagesRequest(roomId, token, 100, Direction.Backward);
          pages++;
          let reachedBoundary = false;
          for (const raw of page.chunk) {
            const event = client.getEventMapper()({ ...raw, room_id: roomId });
            if ((opts?.restoreStopAtEventId && event.getId() === opts.restoreStopAtEventId) || event.getTs() < joinedAt) { reachedBoundary = true; break; }
            liveEvents.add(event);
            await client.decryptEventIfNeeded(event).catch(() => log('recovery_decryption_failed'));
            rememberDecryption(event);
            if (event.getType() === 'm.room.encrypted' || event.isDecryptionFailure()) { undecryptable++; liveEvents.delete(event); }
          }
          if (reachedBoundary || page.chunk.length === 0 || !page.end) break;
          if (pages >= RESTORE_HISTORY_MAX_PAGES) {
            const count = `restore_catchup_truncated pages=${pages}`;
            if (opts?.log) log(count); else process.stderr.write(`${count}\n`);
            break;
          }
          if (seenTokens.has(page.end)) throw new Error('recovery_pagination_stalled');
          seenTokens.add(page.end); token = page.end;
        }
        if (undecryptable > 0) {
          const count = `history_undecryptable=${undecryptable}`;
          if (opts?.log) log(count); else process.stderr.write(`${count}\n`);
        }
      }
      recovering = false;
      if (!joinedRoom) client.on(RoomEvent.MyMembership, membershipEnded);
      joinedRoom = roomId;
      for (const event of [...liveEvents].sort((a, b) => a.getTs() - b.getTs())) { if (event.getRoomId() === roomId) deliver(event); }
    },
    joinedAt: roomId => joinTimes.get(roomId),
    async history(roomId, limit, before, options) {
      if (stopped) throw new Error('session_stopped');
      let token: string | null = null;
      if (before !== undefined) {
        const context = await guarded(roomId, () => client.http.authedRequest<{ start: string }>(Method.Get, `/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(before)}`, { limit: '0' }));
        token = context.start;
      }
      const res = await guarded(roomId, () => client.createMessagesRequest(roomId, token, limit, Direction.Backward));
      const messages: SessionMessage[] = [];
      let undecryptable = 0;
      let oldest: string | undefined;
      let oldestTs: number | undefined;
      let reachedBoundary = false;
      for (const raw of res.chunk) {
        const event = client.getEventMapper()({ ...raw, room_id: roomId });
        oldest = event.getId();
        oldestTs = Math.min(oldestTs ?? event.getTs(), event.getTs());
        if (options?.stopAtEventId && oldest === options.stopAtEventId) {
          reachedBoundary = true;
          break;
        }
        try { await client.decryptEventIfNeeded(event); } catch { /* Report decryption failures below. */ }
        rememberDecryption(event);
        if (event.getType() === 'm.room.encrypted' || event.isDecryptionFailure()) {
          undecryptable++;
          const eventId = event.getId(), sender = event.getSender();
          // Unknown encrypted types are diagnostics for explicit reads, never
          // confirmed messages eligible for restore intake or agent wakes.
          if (options?.includeUnavailable !== false && eventId && sender && eventId !== before) {
            const body = '[Encrypted message unavailable: this device does not have its key. Keys may not have been shared for messages sent before joining or while this agent was offline.]';

            messages.push({ eventId, roomId, sender, ts: event.getTs(), type: 'm.room.message', body,
              content: { msgtype: 'm.notice', body, 'com.khala.unavailable': true } });
          }
          continue;
        }
        const m = message(event);
        if (m && m.eventId !== before) messages.push(m);
      }
      const count = `history_undecryptable=${undecryptable}`;
      log(count);
      if (options?.includeUnavailable === false && undecryptable > 0 && !opts?.log) process.stderr.write(`${count}\n`);
      messages.reverse();
      // Unsupported state/command events still advance pagination. Otherwise an
      // empty projected page would hide older messages during restore catch-up.
      return { messages, ...(typeof res.end === 'string' && oldest ? { nextBefore: oldest } : {}),
        ...(options?.includeUnavailable === false || options?.stopAtEventId ? { ...(oldestTs === undefined ? {} : { oldestTs }), reachedBoundary } : {}) };
    },
    async send(roomId, text) { if (stopped) throw new Error('session_stopped'); const res = await guarded(roomId, () => client.sendTextMessage(roomId, text)); return { eventId: res.event_id }; },
    async sendChannelEvent(roomId, content, txnId) {
      if (stopped) throw new Error('session_stopped');
      const res = await guarded(roomId, () => client.sendEvent(roomId, CHANNEL_EVENT_TYPE as never, content as never, txnId));
      return { eventId: res.event_id };
    },
    roomName(roomId) { return client.getRoom(roomId)?.name ?? undefined; },
    displayName(userId) {
      const value = joinedRoom && client.getRoom(joinedRoom)?.currentState.getStateEvents('m.room.member', userId)?.getContent().displayname;
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
    stop,
  };
}
