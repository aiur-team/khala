// Browser `ChannelSubstrate` over the authenticated loopback channel API. The
// hosted channel service supplies journaling, send dedupe and the projection;
// this adapter only maps HTTP outcomes onto substrate results and turns the
// credential-scoped hint stream into live channel updates.

import type { CallOptions, ContentLimits, Disposer, EventId, RoomId, ChannelRejection } from '@khala/contracts/messaging/index';
import type {
  AcceptedEvent, ChannelSubstrate, CreateLookup, SubstrateEffect, SubstrateEvent, SubstrateRead, SubstrateUpdate,
} from '../../channels/substrate';
import { readHintStream } from './hint-stream';
import { API, type LocalHuman, REQUEST_SECRET_HEADER, decodeChannel, decodeSent, decodeSession, decodeTimeline } from './protocol';

/**
 * Transport state shared by every request and hint stream of one browser session.
 * `auth_failed` is terminal: the session credential was refused and only a
 * relaunch issues a new one. `stopped` follows an exhausted reconnect budget
 * or lost channel access; `retry()` starts over from it.
 */
export type LocalTransportState =
  | Readonly<{ kind: 'connecting' }>
  | Readonly<{ kind: 'live' }>
  | Readonly<{ kind: 'reconnecting'; attempt: number }>
  | Readonly<{ kind: 'stopped' }>
  | Readonly<{ kind: 'auth_failed' }>;

export interface LocalTransport {
  current(): LocalTransportState;
  subscribe(listener: (state: LocalTransportState) => void): Disposer;
  /** Reconnects every hint stream after `stopped`. A no-op in any other state. */
  retry(): void;
}

export type SessionRead =
  | Readonly<{ kind: 'ok'; human: LocalHuman }>
  | Readonly<{ kind: 'auth_failed' }>
  | Readonly<{ kind: 'unavailable' }>;

type Timers = Readonly<{ set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }>;

export type HttpRoomSubstrateOptions = Readonly<{
  /** Exactly `http://127.0.0.1:<port>`: the page's own origin. */
  origin: string;
  requestSecret: string;
  limits: ContentLimits;
  /** Current device lifecycle generation; tags every published update. */
  generation: () => number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** One delay per reconnect attempt; when they run out the transport is `stopped`. */
  reconnectDelaysMs?: readonly number[];
  /** A stream silent this long is presumed dead. The server sends a keepalive every 15 s. */
  idleTimeoutMs?: number;
  pageSize?: number;
  /** Older pages read after a gap before an update is published anyway. */
  maxCatchUpPages?: number;
  timers?: Timers;
}>;

export interface HttpRoomSubstrate extends ChannelSubstrate {
  readonly transport: LocalTransport;
  /** The human authority this browser session holds. */
  session(options?: CallOptions): Promise<SessionRead>;
  /** Ends every hint stream; later updates are never published. */
  close(): void;
}

export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export function isLoopbackOrigin(value: string): boolean {
  const port = LOOPBACK_ORIGIN.exec(value)?.[1];
  return port !== undefined && Number(port) <= 65_535;
}

const REJECTIONS: Readonly<Record<string, ChannelRejection>> = {
  forbidden: 'forbidden',
  forbidden_origin: 'forbidden',
  not_joined: 'not_joined',
  not_found: 'not_found',
  operation_mismatch: 'operation_mismatch',
  invalid_request: 'invalid_request',
  invalid_cursor: 'invalid_request',
  bad_request: 'invalid_request',
  payload_too_large: 'too_large',
};

type Reply = Readonly<{ status: number; body: unknown }> | 'network' | 'auth_failed';

type Stream = {
  readonly roomId: RoomId;
  readonly listener: (update: SubstrateUpdate) => void;
  readonly published: Set<EventId>;
  controller: AbortController | null;
  timer: unknown;
  idle: unknown;
  attempt: number;
  refreshing: boolean;
  dirty: boolean;
  open: boolean;
};

export function createHttpRoomSubstrate(options: HttpRoomSubstrateOptions): HttpRoomSubstrate {
  if (!isLoopbackOrigin(options.origin)) throw new TypeError('local substrate origin must be http://127.0.0.1:<port>');
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  const pageSize = options.pageSize ?? 50;
  const maxCatchUpPages = options.maxCatchUpPages ?? 10;
  const timers: Timers = options.timers ?? {
    set: (callback, ms) => globalThis.setTimeout(callback, ms),
    clear: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const streams = new Set<Stream>();
  // Titles of creates attempted by this page, so a replay carries the same request.
  const createTitles = new Map<string, string | null>();
  const stateListeners = new Set<(state: LocalTransportState) => void>();
  let state: LocalTransportState = { kind: 'connecting' };
  let closed = false;

  function setState(next: LocalTransportState): void {
    // A refused credential never recovers in this page; nothing overrides it.
    if (state.kind === 'auth_failed' || closed) return;
    if (next.kind === state.kind && (next.kind !== 'reconnecting' || next.attempt === (state as { attempt: number }).attempt)) return;
    state = next;
    for (const listener of stateListeners) {
      try { listener(state); } catch { /* One observer cannot stop the others. */ }
    }
  }

  function authFailed(): void {
    setState({ kind: 'auth_failed' });
    for (const stream of streams) halt(stream);
  }

  async function call(path: string, init: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>, signal?: AbortSignal): Promise<Reply> {
    if (state.kind === 'auth_failed') return 'auth_failed';
    let response: Response;
    try {
      response = await request(`${options.origin}${path}`, {
        method: init.method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          [REQUEST_SECRET_HEADER]: options.requestSecret,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch {
      return 'network';
    }
    if (response.status === 401) {
      authFailed();
      return 'auth_failed';
    }
    let body: unknown = null;
    if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      try { body = await response.json(); } catch { body = null; }
    }
    return { status: response.status, body };
  }

  function codeOf(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const error = (body as { error?: unknown }).error;
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : (body as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }

  function rejectionOf(reply: Readonly<{ status: number; body: unknown }>): ChannelRejection | null {
    if (reply.status < 400 || reply.status >= 500) return null;
    return REJECTIONS[codeOf(reply.body) ?? ''] ?? null;
  }

  async function read<T>(path: string, decode: (body: unknown) => T | null, signal?: AbortSignal): Promise<SubstrateRead<T>> {
    const reply = await call(path, { method: 'GET' }, signal);
    if (reply === 'network' || reply === 'auth_failed') return { kind: 'unavailable' };
    if (reply.status === 200) {
      const value = decode(reply.body);
      return value === null ? { kind: 'unavailable' } : { kind: 'done', value };
    }
    const code = rejectionOf(reply);
    return code ? { kind: 'rejected', code } : { kind: 'unavailable' };
  }

  /**
   * A POST may have landed unless the server provably refused it before the
   * handler ran: authentication, admission and overload replies are
   * `unavailable`; a lost or malformed response is `unknown`.
   */
  async function effect<T>(path: string, body: unknown, decode: (body: unknown) => T | null, signal?: AbortSignal): Promise<SubstrateEffect<T>> {
    if (signal?.aborted) return { kind: 'unavailable' };
    const reply = await call(path, { method: 'POST', body }, signal);
    if (reply === 'auth_failed') return { kind: 'unavailable' };
    if (reply === 'network') return { kind: 'unknown' };
    if (reply.status === 200 || reply.status === 201) {
      const value = decode(reply.body);
      return value === null ? { kind: 'unknown' } : { kind: 'done', value };
    }
    const code = rejectionOf(reply);
    if (code) return { kind: 'rejected', code };
    const errorCode = codeOf(reply.body);
    if (reply.status === 503 && (errorCode === 'too_many_requests' || errorCode === 'unavailable')) return { kind: 'unavailable' };
    return reply.status >= 500 ? { kind: 'unknown' } : { kind: 'unavailable' };
  }

  const channelOf = (body: unknown, withParticipants: boolean) => {
    const decoded = decodeChannel(body, options.limits, withParticipants);
    return decoded.ok ? decoded.value.channel : null;
  };

  function timelinePath(roomId: RoomId, cursor: string | null, limit: number): string {
    const query = new URLSearchParams();
    if (cursor !== null) query.set('cursor', cursor);
    query.set('limit', String(limit));
    return `${API.timeline(roomId)}?${query}`;
  }

  async function page(roomId: RoomId, cursor: string | null, limit: number, signal?: AbortSignal) {
    return read(timelinePath(roomId, cursor, limit), body => {
      const decoded = decodeTimeline(body, roomId, options.limits);
      return decoded.ok ? decoded.value : null;
    }, signal);
  }

  // Hint streams --------------------------------------------------------------

  function halt(stream: Stream): void {
    stream.controller?.abort();
    stream.controller = null;
    timers.clear(stream.timer);
    timers.clear(stream.idle);
  }

  function reconnect(stream: Stream): void {
    halt(stream);
    if (!stream.open || closed || state.kind === 'auth_failed') return;
    if (stream.attempt >= delays.length) {
      setState({ kind: 'stopped' });
      return;
    }
    const delay = delays[stream.attempt]!;
    stream.attempt += 1;
    setState({ kind: 'reconnecting', attempt: stream.attempt });
    stream.timer = timers.set(() => void connect(stream), delay);
  }

  function watchIdle(stream: Stream, controller: AbortController): void {
    timers.clear(stream.idle);
    stream.idle = timers.set(() => controller.abort(), idleTimeoutMs);
  }

  async function connect(stream: Stream): Promise<void> {
    if (!stream.open || closed || state.kind === 'auth_failed') return;
    const controller = new AbortController();
    stream.controller = controller;
    let response: Response;
    try {
      response = await request(`${options.origin}${API.hints(stream.roomId)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'text/event-stream', [REQUEST_SECRET_HEADER]: options.requestSecret },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      if (stream.controller === controller) reconnect(stream);
      return;
    }
    if (stream.controller !== controller) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    if (response.status === 401) {
      authFailed();
      return;
    }
    if (response.status === 403 || response.status === 404) {
      // Access to this channel is gone; retrying the same stream cannot restore it.
      halt(stream);
      setState({ kind: 'stopped' });
      return;
    }
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      reconnect(stream);
      return;
    }
    watchIdle(stream, controller);
    try {
      await readHintStream(response.body, frame => {
        if (frame === 'ready') {
          stream.attempt = 0;
          setState({ kind: 'live' });
        }
        void refresh(stream);
      }, () => watchIdle(stream, controller));
    } catch {
      /* Handled as a lost stream below. */
    }
    if (stream.controller === controller) reconnect(stream);
  }

  async function refresh(stream: Stream): Promise<void> {
    if (stream.refreshing) {
      stream.dirty = true;
      return;
    }
    stream.refreshing = true;
    try {
      do {
        stream.dirty = false;
        await pull(stream);
      } while (stream.dirty && stream.open);
    } finally {
      stream.refreshing = false;
    }
  }

  /** Rereads the channel and its newest events, walking back over a gap until it meets what was already published. */
  async function pull(stream: Stream): Promise<void> {
    const generation = options.generation();
    const room = await read(API.channel(stream.roomId), body => channelOf(body, true));
    if (room.kind !== 'done' || !stream.open) return;
    let newest = await page(stream.roomId, null, pageSize);
    if (newest.kind !== 'done' || !stream.open) return;
    const events: SubstrateEvent[] = [...newest.value.events];
    const overlaps = () => stream.published.size === 0 || events.some(event => stream.published.has(event.eventId));
    for (let pages = 0; pages < maxCatchUpPages && !overlaps() && newest.kind === 'done' && newest.value.nextCursor !== null; pages += 1) {
      newest = await page(stream.roomId, newest.value.nextCursor, pageSize);
      if (newest.kind !== 'done' || !stream.open) break;
      events.unshift(...newest.value.events);
    }
    if (!stream.open) return;
    for (const event of events) stream.published.add(event.eventId);
    stream.listener({ generation, room: room.value, events });
  }

  const transport: LocalTransport = {
    current: () => state,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    retry() {
      if (state.kind !== 'stopped' || closed) return;
      state = { kind: 'connecting' };
      for (const listener of stateListeners) listener(state);
      for (const stream of streams) {
        halt(stream);
        stream.attempt = 0;
        void connect(stream);
      }
    },
  };

  return {
    transport,

    async session(callOptions) {
      const reply = await call(API.session, { method: 'GET' }, callOptions?.signal);
      if (reply === 'auth_failed') return { kind: 'auth_failed' };
      if (reply === 'network' || reply.status !== 200) return { kind: 'unavailable' };
      const decoded = decodeSession(reply.body);
      return decoded.ok ? { kind: 'ok', human: decoded.value } : { kind: 'unavailable' };
    },

    createRoom(input, callOptions) {
      createTitles.set(input.operationId, input.title);
      return effect(API.channels, { operationId: input.operationId, title: input.title }, body => channelOf(body, false), callOptions?.signal);
    },

    async findCreatedRoom(input, callOptions): Promise<CreateLookup> {
      // The loopback create is idempotent on `operationId` and its request:
      // replaying the same operation returns the channel it created and can
      // never create a second. Without the original title (another page made
      // the attempt) nothing can be proven, so the create stays unknown.
      if (!createTitles.has(input.operationId)) return { kind: 'unknown' };
      const title = createTitles.get(input.operationId) ?? null;
      const replay = await effect(API.channels, { operationId: input.operationId, title }, body => channelOf(body, false), callOptions?.signal);
      if (replay.kind === 'done') return { kind: 'found', room: replay.value };
      return replay.kind === 'unavailable' ? { kind: 'unavailable' } : { kind: 'unknown' };
    },

    room(roomId, callOptions) {
      return read(API.channel(roomId), body => channelOf(body, true), callOptions?.signal);
    },

    sendEvent(input, callOptions): Promise<SubstrateEffect<AcceptedEvent>> {
      return effect(API.messages(input.roomId), { clientTxnId: input.clientTxnId, content: input.content }, body => {
        const decoded = decodeSent(body, input.roomId, options.limits);
        return decoded.ok ? decoded.value : null;
      }, callOptions?.signal);
    },

    timeline(input, callOptions) {
      return page(input.roomId, input.cursor, input.limit, callOptions?.signal);
    },

    subscribe(roomId, listener) {
      if (closed) return () => undefined;
      const stream: Stream = {
        roomId, listener, published: new Set(), controller: null, timer: undefined, idle: undefined,
        attempt: 0, refreshing: false, dirty: false, open: true,
      };
      streams.add(stream);
      void connect(stream);
      return () => {
        stream.open = false;
        streams.delete(stream);
        halt(stream);
      };
    },

    close() {
      if (closed) return;
      for (const stream of streams) {
        stream.open = false;
        halt(stream);
      }
      streams.clear();
      closed = true;
      stateListeners.clear();
    },
  };
}
