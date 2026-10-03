import { decodeListeningModeCommand, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import { applyListeningMode, readListeningMode } from './mode';
import { createHash } from 'node:crypto';
import { encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import type { AgentCredentials, AgentJoinCreated, Harness } from '@khala/contracts/m1/agent-join';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { CHANNEL_EVENT_TYPE } from '@khala/contracts/m1/channel-event';
import { createEventKeyFilter, isWakeEntry, toEventInboxEntry } from './events/receive';
import { KhalaClientError, type KhalaAgentClient } from './client';
import { appendInbox, unreadCount } from './inbox';
import { requestJoin, pollJoin, reportReady } from './join';
import type { ChannelSession, SessionMessage, SessionModeCommand, StartSession } from './transport';
import { startChannelSession } from './transport';
import { toInboxEntry } from './sender';
import { hostedUsernameFromAgentName, saveHostedUsername } from './local/identity';
import { ensureStateDir, filesForDir, readStateFile, removeStateFile, resolveStateDir, writeStateFile, StateError, type JoinFile, type StatusFile } from './state';

export type KhalaAgentClientOptions = {
  harness: Harness; sessionId: string; env?: NodeJS.ProcessEnv;
  now?: () => Date; startSession?: StartSession;
  joinApi?: { requestJoin: typeof requestJoin; pollJoin: typeof pollJoin; reportReady: typeof reportReady };
  fetch?: typeof fetch; inviteTimeoutMs?: number; autoConfirmWaitMs?: number; onInboxAppend?: (entry: InboxEntry) => void;
};
type Attempt = {
  link: string; created: AgentJoinCreated & { origin: string }; controller: AbortController;
  task: Promise<void>; session?: ChannelSession; credentials?: AgentCredentials;
  unsubscribe?: () => void; unsubscribeMode?: () => void; unsubscribeEnded?: () => void; joined: boolean;
};
function safeError(error: unknown): KhalaClientError {
  return error instanceof KhalaClientError ? error : new KhalaClientError('internal_error',
    error instanceof StateError ? error.code : undefined);
}

function errorDetail(error: unknown, fallback: string): string {
  const failure = safeError(error);
  return ['unsafe_state_dir', 'storage_failed'].includes(failure.message) ? failure.message : fallback;
}

export function createKhalaAgentClient(options: KhalaAgentClientOptions): KhalaAgentClient {
  const dir = resolveStateDir(options.harness, options.sessionId, options.env);
  const now = options.now ?? (() => new Date());
  const fetchDeps = options.fetch ? { fetch: options.fetch } : {};
  const api = options.joinApi ?? { requestJoin, pollJoin, reportReady };
  let status: StatusFile = { state: 'idle', updatedAt: now().toISOString() };
  let initialization: Promise<void> | undefined;
  let active: Attempt | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let joins: Promise<unknown> = Promise.resolve();
  let appends: Promise<void> = Promise.resolve();
  let statusWrites: Promise<void> = Promise.resolve();
  let acceptEventKey = createEventKeyFilter();

  function inboxEntry(message: SessionMessage, session: ChannelSession, acceptKey: ReturnType<typeof createEventKeyFilter>): InboxEntry | null {
    const entry = toInboxEntry(message, session.displayName(message.sender));
    if (message.type === 'm.room.message') return entry;
    if (message.type !== CHANNEL_EVENT_TYPE) return null;
    const { eventId, roomId, ts, sender, senderLabel, senderKind } = entry;
    const base = { eventId, roomId, ts, sender, senderLabel, senderKind };
    const event = toEventInboxEntry(base, message.content);
    return event && acceptKey(event.key) ? event.entry : null;
  }

  function setStatus(state: StatusFile['state'], detail?: string): Promise<void> {
    const next: StatusFile = { state, ...(status.channelName !== undefined ? { channelName: status.channelName } : {}),
      ...(detail !== undefined ? { detail } : {}), updatedAt: now().toISOString() };
    status = next;
    statusWrites = statusWrites.catch(() => {}).then(() => writeStateFile(dir, 'status.json', next));
    return statusWrites;
  }
  function initialize(): Promise<void> {
    return initialization ??= (async () => {
      await ensureStateDir(dir);
      // M1 never resumes a saved Matrix account on a new process/device.
      await removeStateFile(dir, 'session.json');
      await removeStateFile(dir, 'mode.json');
      await setStatus('idle');
    })();
  }
  function current(attempt: Attempt): boolean {
    return active === attempt && !closed && !attempt.controller.signal.aborted;
  }
  async function cleanup(attempt: Attempt): Promise<void> {
    attempt.unsubscribe?.();
    attempt.unsubscribeMode?.();
    attempt.unsubscribeEnded?.();
    const session = attempt.session;
    delete attempt.session;
    await session?.stop().catch(() => {});
    await removeStateFile(dir, 'session.json');
  }
  async function cancel(): Promise<void> {
    if (!active) return;
    const attempt = active;
    attempt.controller.abort();
    await attempt.task;
    await appends;
    await cleanup(attempt);
    active = undefined;
  }
  function requireSession(): { session: ChannelSession; credentials: AgentCredentials; attempt: Attempt } {
    if (closed || !active?.joined || active.controller.signal.aborted || !active.session || !active.credentials) throw new KhalaClientError('not_connected');
    return { session: active.session, credentials: active.credentials, attempt: active };
  }
  async function publishMode(attempt: Attempt, session: ChannelSession, roomId: string, mode: ListeningMode): Promise<void> {
    const controller = new AbortController();
    let release = () => {};
    const aborted = new Promise<void>(resolve => { release = resolve; });
    const abort = () => { controller.abort(); release(); };
    const timer = setTimeout(abort, 5000);
    attempt.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      if (attempt.controller.signal.aborted) { abort(); return; }
      await Promise.race([session.publishListeningMode(roomId, mode, controller.signal).catch(() => {}), aborted]);
    } finally {
      clearTimeout(timer);
      attempt.controller.signal.removeEventListener('abort', abort);
    }
  }
  async function background(attempt: Attempt): Promise<void> {
    const { signal } = attempt.controller;
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new KhalaClientError('internal_error'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    try {
      const input = { origin: attempt.created.origin, joinId: attempt.created.joinId, pollSecret: attempt.created.pollSecret };
      const credentials = await wait(api.pollJoin(input, { signal, ...fetchDeps }));
      if (!current(attempt)) return;
      attempt.credentials = credentials;
      await writeStateFile(dir, 'session.json', credentials);
      if (!current(attempt)) return;
      const starting = (options.startSession ?? startChannelSession)(credentials).then(async session => {
        if (!current(attempt)) { await session.stop(); throw new KhalaClientError('internal_error'); }
        attempt.session = session;
        return session;
      });
      const session = await wait(starting);
      if (session.onEnded) attempt.unsubscribeEnded = session.onEnded(reason => {
        if (!current(attempt)) return;
        void setStatus('disconnected', reason).catch(() => {});
        attempt.controller.abort();
      });
      const buffered: (() => void)[] = [];
      const intake = (message: SessionMessage): void => {
        if (!current(attempt) || message.roomId !== credentials.roomId || message.sender === session.userId) return;
        if (!attempt.joined) { buffered.push(() => intake(message)); return; }
        appends = appends.then(async () => {
          if (!current(attempt)) return;
          const entry = inboxEntry(message, session, acceptEventKey);
          if (!entry) return;
          if (await appendInbox(dir, entry) && current(attempt) && isWakeEntry(entry)) {
            try { options.onInboxAppend?.(entry); } catch { /* A waker cannot break intake. */ }
          }
        }).catch(async () => {
          if (current(attempt)) await setStatus('disconnected', 'internal_error').catch(() => {});
        });
      };
      const intakeMode = (command: SessionModeCommand): void => {
        if (!current(attempt) || command.roomId !== credentials.roomId) return;
        if (!attempt.joined) { buffered.push(() => intakeMode(command)); return; }
        if (command.sender !== session.inviter(credentials.roomId)) return;
        const decoded = decodeListeningModeCommand(command.content);
        if (!decoded.ok || decoded.value.agent !== session.userId) return;
        appends = appends.then(async () => {
          if (!current(attempt)) return;
          await applyListeningMode(filesForDir(dir), decoded.value.mode, { changedBy: 'owner', eventId: command.eventId }, now);
          await publishMode(attempt, session, credentials.roomId, decoded.value.mode);
        }).catch(async () => {
          if (current(attempt)) await setStatus('disconnected', 'internal_error').catch(() => {});
        });
      };
      attempt.unsubscribe = session.onMessage(intake);
      attempt.unsubscribeMode = session.onListeningModeCommand(intakeMode);
      await wait(api.reportReady(input, fetchDeps));
      await wait(session.waitForInvite(credentials.roomId, options.inviteTimeoutMs ?? 120_000));
      await wait(session.join(credentials.roomId));
      if (!current(attempt)) return;
      attempt.joined = true;
      status.channelName = session.roomName(credentials.roomId) ?? credentials.roomId;
      for (const deliver of buffered) deliver();
      if (credentials.transport !== 'local') {
        const own = session.displayName(session.userId);
        const username = own === undefined ? null : hostedUsernameFromAgentName(own, options.harness);
        if (username !== null) appends = appends.then(() => saveHostedUsername(username, options.env)).catch(() => {});
      }
      await removeStateFile(dir, 'join.json');
      if (current(attempt)) await setStatus('connected');
    } catch (error) {
      if (current(attempt)) {
        attempt.joined = false;
        const failure = safeError(error);
        const inviteTimeout = error instanceof Error && error.message === 'invite_timeout';
        await cleanup(attempt);
        await setStatus(failure.code === 'join_expired' ? 'idle' : 'disconnected',
          failure.code === 'join_expired' ? 'join_expired' : inviteTimeout ? 'invite_timeout' : errorDetail(error, failure.code));
        active = undefined;
      }
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  async function settleAutoConfirmed(attempt: Attempt): Promise<'connected' | 'failed' | 'pending'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, options.autoConfirmWaitMs ?? 15_000); });
    try { await Promise.race([attempt.task, timeout]); } finally { clearTimeout(timer); }
    if (closed || attempt.controller.signal.aborted) return 'failed';
    if (active === attempt && attempt.joined) return 'connected';
    return active === attempt ? 'pending' : 'failed';
  }

  return {
    join(link, label) {
      const task = joins.catch(() => {}).then(async () => {
        await initialize();
        if (closed) throw new KhalaClientError('not_connected');
        if (active?.joined && !active.controller.signal.aborted && active.link === link) return { state: 'connected' as const, channelName: status.channelName! };
        if (active?.link === link && !active.controller.signal.aborted) return { state: 'awaiting_confirmation' as const, confirmUrl: active.created.confirmUrl, ...(active.created.autoConfirmed === true ? { autoConfirmed: true as const } : {}) };
        const wasJoined = active?.joined;
        await cancel();
        if (wasJoined) {
          await removeStateFile(dir, 'inbox.jsonl');
          await removeStateFile(dir, 'cursor.json');
          acceptEventKey = createEventKeyFilter();
          delete status.channelName;
        }
        await removeStateFile(dir, 'mode.json');
        const saved = await readStateFile<JoinFile>(dir, 'join.json');
        if (saved?.link === link && Date.parse(saved.expiresAt) <= now().getTime()) {
          await removeStateFile(dir, 'join.json');
          await setStatus('idle', 'join_expired');
          throw new KhalaClientError('join_expired');
        }
        let started: Attempt | undefined;
        try {
          const created = await api.requestJoin({ link, harness: options.harness, label }, fetchDeps);
          if (closed) throw new KhalaClientError('not_connected');
          const { joinId, pollSecret, confirmUrl, expiresAt } = created;
          await writeStateFile(dir, 'join.json', { joinId, pollSecret, confirmUrl, expiresAt, link });
          await setStatus('joining');
          const attempt: Attempt = { link, created, controller: new AbortController(), task: Promise.resolve(), joined: false };
          active = attempt;
          // All failures, including storage cleanup failures, are contained here.
          attempt.task = background(attempt).catch(() => {});
          started = attempt;
          if (created.autoConfirmed !== true) return { state: 'awaiting_confirmation' as const, confirmUrl };
        } catch (error) {
          const failure = safeError(error);
          if (!closed) await setStatus('idle', failure.message);
          throw failure;
        }
        const outcome = await settleAutoConfirmed(started!);
        if (outcome === 'connected') return { state: 'connected' as const, channelName: status.channelName ?? started!.credentials!.roomId };
        if (outcome === 'failed') {
          if (closed) throw new KhalaClientError('not_connected');
          throw new KhalaClientError(status.detail === 'join_expired' ? 'join_expired' : 'internal_error', status.detail ?? 'internal_error');
        }
        return { state: 'awaiting_confirmation' as const, confirmUrl: started!.created.confirmUrl, autoConfirmed: true as const };
      });
      joins = task;
      return task;
    },
    async status() {
      await initialize();
      await appends;
      const unread = (await unreadCount(dir)).total;
      return { state: status.state, ...(status.detail !== undefined ? { detail: status.detail } : {}), ...(status.channelName !== undefined ? { channelName: status.channelName } : {}),
        ...(active?.joined && !active.controller.signal.aborted && active.session ? { agentUserId: active.session.userId } : {}), unread, listeningMode: await readListeningMode(filesForDir(dir)) };
    },
    async read(limit, before) {
      await initialize();
      const { session, credentials } = requireSession();
      try {
        const page = await session.history(credentials.roomId, limit, before);
        const acceptKey = createEventKeyFilter();
        return { messages: page.messages.map(m => inboxEntry(m, session, acceptKey)).filter((entry): entry is InboxEntry => entry !== null),
          ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}) };
      } catch (error) { throw safeError(error); }
    },
    async send(text) {
      await initialize();
      const { session, credentials, attempt } = requireSession();
      try {
        const sent = await session.send(credentials.roomId, text);
        if (current(attempt) && status.state === 'send_failed') await setStatus('connected');
        return sent;
      } catch (error) {
        if (current(attempt)) await setStatus('send_failed', errorDetail(error, 'send_failed'));
        throw new KhalaClientError('send_failed');
      }
    },
    async sendChannelEvent(content) {
      await initialize();
      const { session, credentials, attempt } = requireSession();
      const encoded = encodeChannelEvent(content);
      if (!encoded.ok) throw new KhalaClientError('internal_error', 'invalid_event');
      const txnId = encoded.value.key === undefined ? undefined
        : 'khev-' + createHash('sha256').update(encoded.value.key).digest('hex').slice(0, 32);
      try {
        const sent = await session.sendChannelEvent(credentials.roomId, encoded.value, txnId);
        if (current(attempt) && status.state === 'send_failed') await setStatus('connected');
        return sent;
      } catch (error) {
        if (current(attempt)) await setStatus('send_failed', errorDetail(error, 'send_failed'));
        throw new KhalaClientError('send_failed');
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      active?.controller.abort();
      closing = (async () => {
        await initialize();
        await joins.catch(() => {});
        await cancel();
        await appends;
        await removeStateFile(dir, 'session.json');
        await setStatus('disconnected', 'closed');
      })();
      return closing;
    },
  };
}
