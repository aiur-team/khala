import { randomUUID } from 'node:crypto';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { CHANNEL_EVENT_TYPE } from '@khala/contracts/m1/channel-event';
import { LISTENING_MODE_COMMAND_TYPE } from '@khala/contracts/m1/listening-mode';
import {
  decodeLocalMe, decodeLocalJoined, decodeLocalEventsPage, decodeLocalHistoryPage,
  decodeLocalSendResult, decodeLocalMembersResponse, decodeLocalMemberContent,
  decodeLocalNameContent, decodeLocalErrorBody, localRoomPath, LOCAL_OWNER_USER_ID,
  LOCAL_LONG_POLL_MAX_S, type LocalEvent, type LocalMe,
} from '@khala/contracts/m1/local';
import { KhalaClientError } from '../client';
import type { ChannelSession, SessionEndReason, SessionMessage, SessionModeCommand } from '../transport';
import { ensureHelper } from './lifecycle';

export type LocalSessionOptions = { fetch?: typeof fetch; ensureHelper?: () => Promise<void>; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; log?: (line: string) => void };
class LocalCallError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
class LocalNetworkError extends Error {
  constructor(readonly refused: boolean) { super('local_network_error'); }
}
type Decoder<T> = (value: unknown) => { ok: true; value: T } | { ok: false };
function decoded<T>(value: unknown, decoder: Decoder<T>): T {
  const result = decoder(value);
  if (!result.ok) throw new LocalCallError(0, 'protocol');
  return result.value;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('session_stopped')); return; }
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('session_stopped')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function refused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } } | null)?.cause;
  return cause?.code === 'ECONNREFUSED' || cause?.errors?.some(e => e.code === 'ECONNREFUSED') === true;
}
function message(event: LocalEvent): SessionMessage {
  return { eventId: event.eventId, roomId: event.roomId, sender: event.sender, ts: event.ts,
    type: event.type as SessionMessage['type'], body: typeof event.content['body'] === 'string' ? event.content['body'] : '', content: event.content };
}

export async function createLocalSession(creds: AgentCredentials, opts: LocalSessionOptions = {}): Promise<ChannelSession> {
  let origin: string;
  try {
    // Check the original spelling too: URL parsing normalizes IP aliases and paths.
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+\/?$/iu.test(creds.homeserver)) throw new Error();
    origin = new URL(creds.homeserver).origin;
  } catch {
    throw new KhalaClientError('internal_error', 'invalid_local_origin');
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const pause = opts.sleep ?? sleep;
  const log = opts.log ?? (() => {});
  const ensure = async (): Promise<void> => {
    try { await (opts.ensureHelper ?? (async () => { await ensureHelper(process.env); }))(); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw new KhalaClientError('internal_error', code === 'unsafe_state_dir' || code === 'storage_failed' ? code : 'helper_unavailable');
    }
  };
  const controller = new AbortController();
  const names = new Map<string, string>();
  const messages = new Set<(m: SessionMessage) => void>();
  const modes = new Set<(c: SessionModeCommand) => void>();
  const ended = new Set<(reason: SessionEndReason) => void>();
  let stopped = false;
  let terminal: LocalCallError | undefined;
  let joined = false;
  let joining: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  let name: string | undefined;
  let invitedBy: string | undefined;
  let after = 0;
  function check(roomId: string): void {
    if (stopped) throw new Error('session_stopped');
    if (roomId !== creds.roomId) throw new Error('unknown_room');
    if (terminal) throw terminal;
  }
  async function request(method: string, tail: string, body?: unknown, signal?: AbortSignal, timeout = 10_000): Promise<unknown> {
    check(creds.roomId);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await fetchImpl(origin + localRoomPath(creds.roomId, tail), {
        method, headers: { authorization: `Bearer ${creds.accessToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: combined,
      });
    } catch (error) {
      if (stopped) throw new Error('session_stopped');
      if (signal?.aborted) throw new Error('request_aborted');
      throw new LocalNetworkError(refused(error));
    }
    if (stopped) throw new Error('session_stopped');
    if (signal?.aborted) throw new Error('request_aborted');
    if (response.status === 204) return undefined;
    let value: unknown;
    try { value = await response.json(); }
    catch {
      if (stopped) throw new Error('session_stopped');
      if (signal?.aborted) throw new Error('request_aborted');
      throw new LocalCallError(response.ok ? 0 : response.status, response.ok ? 'protocol' : `http_${response.status}`);
    }
    check(creds.roomId);
    if (signal?.aborted) throw new Error('request_aborted');
    if (!response.ok) {
      const error = decodeLocalErrorBody(value);
      throw new LocalCallError(response.status, error.ok && !error.value.error.includes(creds.accessToken) ? error.value.error : `http_${response.status}`);
    }
    return value;
  }
  async function withHelper<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof LocalNetworkError && error.refused) || stopped) throw error;
      log('local_helper_restart');
      await ensure();
      return call();
    }
  }
  function cache(me: LocalMe): void {
    if (me.userId !== creds.userId || me.roomId !== creds.roomId) throw new LocalCallError(0, 'protocol');
    names.set(me.userId, me.displayName);
    name = me.roomName;
    if (me.invitedBy !== undefined) invitedBy = me.invitedBy;
  }
  async function me(): Promise<LocalMe> {
    const value = decoded(await withHelper(() => request('GET', 'me')), decodeLocalMe);
    cache(value);
    return value;
  }
  function dispatch(event: LocalEvent): void {
    if (stopped || event.roomId !== creds.roomId) return;
    if (event.type === 'm.room.member') {
      const content = decoded(event.content, decodeLocalMemberContent);
      names.set(content.user, content.displayname);
      return;
    }
    if (event.type === 'm.room.name') { name = decoded(event.content, decodeLocalNameContent).name; return; }
    if (event.type === 'm.room.create' || event.sender === creds.userId) return;
    if (event.type === LISTENING_MODE_COMMAND_TYPE) {
      for (const handler of modes) {
        if (stopped) break;
        try { handler({ eventId: event.eventId, roomId: event.roomId, sender: event.sender, ts: event.ts, content: event.content }); }
        catch { log('mode_handler_error'); }
      }
    } else if (event.type === 'm.room.message' || event.type === CHANNEL_EVENT_TYPE) {
      for (const handler of messages) {
        if (stopped) break;
        try { handler(message(event)); } catch { log('message_handler_error'); }
      }
    }
  }
  async function run(): Promise<void> {
    let backoff = 500;
    let streak = 0;
    let lastEnsureAt = 0;
    while (!stopped) {
      try {
        const page = decoded(await request('GET', `events?after=${after}&wait=${LOCAL_LONG_POLL_MAX_S}`, undefined,
          controller.signal, (LOCAL_LONG_POLL_MAX_S + 10) * 1000), decodeLocalEventsPage);
        if (stopped) return;
        for (const event of page.events) {
          if (event.seq <= after) continue;
          after = event.seq;
          dispatch(event);
        }
        backoff = 500; streak = 0; lastEnsureAt = 0;
      } catch (error) {
        if (stopped) return;
        if (error instanceof LocalCallError && [401, 403, 404].includes(error.status)) {
          terminal = error;
          log(error.status === 404 ? 'local_channel_gone' : 'local_session_revoked');
          const reason = error.status === 404 ? 'channel_deleted' : error.status === 403 ? 'removed' : 'unauthorized';
          for (const handler of ended) {
            try { handler(reason); } catch { log('ended_handler_error'); }
          }
          ended.clear();
          return;
        }
        streak++;
        if (error instanceof LocalNetworkError && error.refused && (lastEnsureAt === 0 || streak - lastEnsureAt >= 5)) {
          lastEnsureAt = streak;
          log('local_helper_restart');
          try { await ensure(); } catch { log('local_helper_unavailable'); }
        }
        if (stopped) return;
        try { await pause(backoff, controller.signal); } catch { return; }
        backoff = Math.min(backoff * 2, 8000);
      }
    }
  }
  await me();
  async function send(roomId: string, type: SessionMessage['type'], content: Record<string, unknown>, txnId = `kls-${randomUUID()}`): Promise<{ eventId: string }> {
    check(roomId);
    return decoded(await withHelper(() => request('POST', 'send', { txnId, type, content })), decodeLocalSendResult);
  }
  return {
    userId: creds.userId,
    onEnded(handler) { if (!stopped) ended.add(handler); return () => { ended.delete(handler); }; },
    inviter: roomId => roomId === creds.roomId ? invitedBy ?? LOCAL_OWNER_USER_ID : undefined,
    roomName: roomId => roomId === creds.roomId ? name : undefined,
    displayName: userId => names.get(userId),
    onMessage(handler) { if (!stopped) messages.add(handler); return () => { messages.delete(handler); }; },
    onListeningModeCommand(handler) { if (!stopped) modes.add(handler); return () => { modes.delete(handler); }; },
    async waitForInvite(roomId, timeoutMs) {
      check(roomId);
      for (let i = 0; i < Math.max(1, Math.ceil(timeoutMs / 250)); i++) {
        const value = await me();
        if (value.membership === 'invite' || value.membership === 'join') return;
        await pause(250, controller.signal);
        check(roomId);
      }
      throw new Error('invite_timeout');
    },
    async join(roomId) {
      check(roomId);
      if (joined) return;
      // Share concurrent joins so there is only one polling loop and cutoff.
      joining ??= (async () => {
        const result = decoded(await withHelper(() => request('POST', 'join', {})), decodeLocalJoined);
        after = result.seq;
        await me();
        const members = decoded(await withHelper(() => request('GET', 'members')), decodeLocalMembersResponse);
        check(roomId);
        for (const member of members.members) names.set(member.userId, member.displayName);
        joined = true;
        loop = run();
      })();
      try { await joining; } finally { joining = undefined; }
    },
    async history(roomId, limit, before) {
      check(roomId);
      const page = decoded(await withHelper(() => request('GET', `messages?limit=${limit}${before !== undefined ? `&before=${encodeURIComponent(before)}` : ''}`)), decodeLocalHistoryPage);
      const result = page.events.filter(e => e.roomId === creds.roomId).map(message);
      return { messages: result, ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}) };
    },
    send: (roomId, text) => send(roomId, 'm.room.message', { msgtype: 'm.text', body: text }),
    sendChannelEvent: (roomId, content, txnId) => send(roomId, CHANNEL_EVENT_TYPE, content, txnId),
    async publishListeningMode(roomId, mode, signal) {
      check(roomId);
      const result = await withHelper(() => request('PUT', `members/${encodeURIComponent(creds.userId)}`, { listeningMode: mode }, signal));
      if (result !== undefined) throw new LocalCallError(0, 'protocol');
    },
    async stop() {
      stopped = true;
      controller.abort();
      messages.clear(); modes.clear(); ended.clear();
      await loop;
    },
  };
}
