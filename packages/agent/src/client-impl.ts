import { createHash } from 'node:crypto';
import { encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import type { AgentCredentials, AgentJoinCreated, Harness } from '@khala/contracts/m1/agent-join';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { KhalaClientError, type KhalaAgentClient } from './client';
import { appendInbox, unreadCount } from './inbox';
import { requestJoin, pollJoin, reportReady } from './join';
import { createAgentMatrixSession, type AgentMatrixSession, type SessionMessage } from './matrix/session';
import { toInboxEntry } from './sender';
import { ensureStateDir, readStateFile, removeStateFile, resolveStateDir, writeStateFile, type JoinFile, type StatusFile } from './state';

export type KhalaAgentClientOptions = {
  harness: Harness; sessionId: string; env?: NodeJS.ProcessEnv;
  now?: () => Date; startSession?: typeof createAgentMatrixSession;
  joinApi?: { requestJoin: typeof requestJoin; pollJoin: typeof pollJoin; reportReady: typeof reportReady };
  fetch?: typeof fetch; inviteTimeoutMs?: number; onInboxAppend?: (entry: InboxEntry) => void;
};
type Attempt = {
  link: string; created: AgentJoinCreated & { origin: string }; controller: AbortController;
  task: Promise<void>; session?: AgentMatrixSession; credentials?: AgentCredentials;
  unsubscribe?: () => void; joined: boolean;
};
function safeError(error: unknown): KhalaClientError {
  return error instanceof KhalaClientError ? error : new KhalaClientError('internal_error');
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
      await setStatus('idle');
    })();
  }
  function current(attempt: Attempt): boolean {
    return active === attempt && !closed && !attempt.controller.signal.aborted;
  }
  async function cleanup(attempt: Attempt): Promise<void> {
    attempt.unsubscribe?.();
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
  function requireSession(): { session: AgentMatrixSession; credentials: AgentCredentials; attempt: Attempt } {
    if (closed || !active?.joined || !active.session || !active.credentials) throw new KhalaClientError('not_connected');
    return { session: active.session, credentials: active.credentials, attempt: active };
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
      const starting = (options.startSession ?? createAgentMatrixSession)(credentials).then(async session => {
        if (!current(attempt)) { await session.stop(); throw new KhalaClientError('internal_error'); }
        attempt.session = session;
        return session;
      });
      const session = await wait(starting);
      const buffered: SessionMessage[] = [];
      const intake = (message: SessionMessage): void => {
        if (!current(attempt) || message.type !== 'm.room.message' || message.roomId !== credentials.roomId || message.sender === session.userId) return;
        if (!attempt.joined) { buffered.push(message); return; }
        appends = appends.then(async () => {
          if (!current(attempt)) return;
          const entry = toInboxEntry(message, session.displayName(message.sender));
          if (await appendInbox(dir, entry) && current(attempt)) {
            try { options.onInboxAppend?.(entry); } catch { /* A waker cannot break intake. */ }
          }
        }).catch(async () => {
          if (current(attempt)) await setStatus('disconnected', 'internal_error').catch(() => {});
        });
      };
      attempt.unsubscribe = session.onMessage(intake);
      await wait(api.reportReady(input, fetchDeps));
      await wait(session.waitForInvite(credentials.roomId, options.inviteTimeoutMs ?? 120_000));
      await wait(session.join(credentials.roomId));
      if (!current(attempt)) return;
      attempt.joined = true;
      status.channelName = session.roomName(credentials.roomId) ?? credentials.roomId;
      for (const message of buffered) intake(message);
      await removeStateFile(dir, 'join.json');
      if (current(attempt)) await setStatus('connected');
    } catch (error) {
      if (current(attempt)) {
        attempt.joined = false;
        const failure = safeError(error);
        const inviteTimeout = error instanceof Error && error.message === 'invite_timeout';
        await cleanup(attempt);
        await setStatus(failure.code === 'join_expired' ? 'idle' : 'disconnected',
          failure.code === 'join_expired' ? 'join_expired' : inviteTimeout ? 'invite_timeout' : failure.code);
        active = undefined;
      }
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  return {
    join(link, label) {
      const task = joins.catch(() => {}).then(async () => {
        await initialize();
        if (closed) throw new KhalaClientError('not_connected');
        if (active?.joined) return { state: 'connected' as const, channelName: status.channelName! };
        if (active?.link === link) return { state: 'awaiting_confirmation' as const, confirmUrl: active.created.confirmUrl };
        await cancel();
        const saved = await readStateFile<JoinFile>(dir, 'join.json');
        if (saved?.link === link && Date.parse(saved.expiresAt) <= now().getTime()) {
          await removeStateFile(dir, 'join.json');
          await setStatus('idle', 'join_expired');
          throw new KhalaClientError('join_expired');
        }
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
          return { state: 'awaiting_confirmation' as const, confirmUrl };
        } catch (error) {
          const failure = safeError(error);
          if (!closed) await setStatus('idle', failure.message);
          throw failure;
        }
      });
      joins = task;
      return task;
    },
    async status() {
      await initialize();
      await appends;
      const unread = (await unreadCount(dir)).total;
      return { state: status.state, ...(status.channelName !== undefined ? { channelName: status.channelName } : {}),
        ...(active?.joined && active.session ? { agentUserId: active.session.userId } : {}), unread };
    },
    async read(limit, before) {
      await initialize();
      const { session, credentials } = requireSession();
      try {
        const page = await session.history(credentials.roomId, limit, before);
        return { messages: page.messages.filter(m => m.type === 'm.room.message').map(m => toInboxEntry(m, session.displayName(m.sender))),
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
      } catch {
        if (current(attempt)) await setStatus('send_failed', 'send_failed');
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
      } catch {
        if (current(attempt)) await setStatus('send_failed', 'send_failed');
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
