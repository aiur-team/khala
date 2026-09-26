import { describe, expect, it } from 'vitest';
import { decodeContentLimits, type RoomId } from '@khala/contracts/messaging/index';
import type { SubstrateUpdate } from '../../channels/substrate';
import { readHintStream } from './hint-stream';
import { REQUEST_SECRET_HEADER } from './protocol';
import { createHttpRoomSubstrate, type LocalTransportState } from './substrate';

const ORIGIN = 'http://127.0.0.1:4871';
const SECRET = 'a'.repeat(43);
const CHANNEL = 'ch_one' as RoomId;
const limits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 16_384, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
  if (!decoded.ok) throw new Error('limits');
  return decoded.value;
})();

const human = { participantId: 'participant_h', kind: 'human', ownerId: 'owner_1', displayName: 'You', deviceIds: ['device_h'] };
const agent = { participantId: 'participant_a', kind: 'agent', ownerId: 'owner_1', displayName: 'Codex', deviceIds: ['device_a'] };
const channel = { channelId: CHANNEL, title: null, membership: 'joined', revision: '3' };

function event(id: string, participant = human, body = id) {
  return {
    eventId: id, channelId: CHANNEL, authorDeviceId: participant.deviceIds[0], participant,
    content: { v: 1, kind: 'text', body }, clientTxnId: null, receivedAt: '2026-09-25T10:00:00.000Z',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

type Call = Readonly<{ url: string; method: string; headers: Record<string, string>; body: unknown; credentials: string | undefined }>;

class Stream {
  controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly body = new ReadableStream<Uint8Array>({ start: controller => { this.controller = controller; } });
  send(text: string) { this.controller.enqueue(new TextEncoder().encode(text)); }
  end() { this.controller.close(); }
}

function harness(routes: (call: Call) => Response | Promise<Response> | 'throw') {
  const calls: Call[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const substrate = createHttpRoomSubstrate({
    origin: ORIGIN,
    requestSecret: SECRET,
    limits,
    generation: () => 7,
    reconnectDelaysMs: [10, 20],
    timers: {
      set(callback, ms) { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
      clear(handle) { if (handle) (handle as { cleared: boolean }).cleared = true; },
    },
    async fetch(input, init) {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const call: Call = {
        url: String(input), method: init?.method ?? 'GET', headers, credentials: init?.credentials,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const reply = await routes(call);
      if (reply === 'throw') throw new TypeError('network');
      return reply;
    },
  });
  const states: LocalTransportState[] = [];
  substrate.transport.subscribe(state => states.push(state));
  const fire = (ms: number) => {
    const timer = timers.find(entry => !entry.cleared && entry.ms === ms);
    if (!timer) throw new Error(`no pending ${ms}ms timer`);
    timer.cleared = true;
    timer.callback();
  };
  return { substrate, calls, states, fire };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('HttpRoomSubstrate requests', () => {
  it('accepts only the exact loopback origin', () => {
    for (const origin of ['http://localhost:4871', 'https://127.0.0.1:4871', 'http://127.0.0.1:4871/', 'http://127.0.0.2:1']) {
      expect(() => createHttpRoomSubstrate({ origin, requestSecret: SECRET, limits, generation: () => 1 })).toThrow(TypeError);
    }
  });

  it('sends the request secret with the same-origin cookie and decodes a channel read', async () => {
    const { substrate, calls } = harness(() => json(200, { channel, participants: [human, agent] }));
    expect(await substrate.room(CHANNEL)).toEqual({
      kind: 'done', value: { roomId: CHANNEL, title: null, membership: 'joined', revision: '3' },
    });
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/api/v1/channels/ch_one`, method: 'GET', credentials: 'same-origin', headers: { [REQUEST_SECRET_HEADER]: SECRET },
    });
  });

  it('maps refusals, malformed bodies and lost reads without inventing success', async () => {
    const replies = [json(403, { error: { code: 'not_joined' } }), json(200, { channel: { ...channel, extra: 1 } }), 'throw' as const];
    const { substrate } = harness(() => replies.shift()!);
    expect(await substrate.room(CHANNEL)).toEqual({ kind: 'rejected', code: 'not_joined' });
    expect(await substrate.room(CHANNEL)).toEqual({ kind: 'unavailable' });
    expect(await substrate.room(CHANNEL)).toEqual({ kind: 'unavailable' });
  });

  it('treats a refused credential as terminal and stops calling the server', async () => {
    const { substrate, calls, states } = harness(() => json(401, { error: { code: 'unauthenticated' } }));
    expect(await substrate.session()).toEqual({ kind: 'auth_failed' });
    expect(await substrate.room(CHANNEL)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
    expect(states).toEqual([{ kind: 'auth_failed' }]);
    substrate.transport.retry();
    expect(substrate.transport.current()).toEqual({ kind: 'auth_failed' });
  });

  it('decodes the session human', async () => {
    const { substrate } = harness(() => json(200, { human: { ownerId: 'owner_1', participantId: 'participant_h', deviceId: 'device_h' } }));
    expect(await substrate.session()).toEqual({ kind: 'ok', human: { ownerId: 'owner_1', participantId: 'participant_h', deviceId: 'device_h' } });
  });

  it('keeps a send unknown whenever it may have landed', async () => {
    const replies: Array<Response | 'throw'> = [
      'throw',
      json(503, { error: { code: 'outcome_unknown' } }),
      json(500, { error: { code: 'internal_error' } }),
      json(201, { state: 'stored', event: { ...event('e1'), channelId: 'ch_other' } }),
      json(503, { error: { code: 'too_many_requests' } }),
      json(400, { error: { code: 'invalid_request' } }),
      json(201, { state: 'stored', event: event('e1') }),
      json(200, { state: 'replayed', event: event('e1') }),
    ];
    const { substrate, calls } = harness(() => replies.shift()!);
    const send = () => substrate.sendEvent({ roomId: CHANNEL, clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hi' } });
    expect(await send()).toEqual({ kind: 'unknown' });
    expect(await send()).toEqual({ kind: 'unknown' });
    expect(await send()).toEqual({ kind: 'unknown' });
    expect(await send()).toEqual({ kind: 'unknown' });
    expect(await send()).toEqual({ kind: 'unavailable' });
    expect(await send()).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(await send()).toEqual({ kind: 'done', value: { eventId: 'e1', authorDeviceId: 'device_h' } });
    expect(await send()).toEqual({ kind: 'done', value: { eventId: 'e1', authorDeviceId: 'device_h' } });
    expect(calls.every(call => call.method === 'POST' && JSON.stringify(call.body) === JSON.stringify({
      clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hi' },
    }))).toBe(true);
  });

  it('reconciles a lost create by replaying the identical operation', async () => {
    const replies: Array<Response | 'throw'> = ['throw', json(200, { channel })];
    const { substrate, calls } = harness(() => replies.shift()!);
    expect(await substrate.findCreatedRoom({ operationId: 'op_never_seen' })).toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(0);
    expect(await substrate.createRoom({ operationId: 'op_1', title: 'Plans' })).toEqual({ kind: 'unknown' });
    expect(await substrate.findCreatedRoom({ operationId: 'op_1' })).toMatchObject({ kind: 'found', room: { roomId: CHANNEL } });
    expect(calls.map(call => call.body)).toEqual([{ operationId: 'op_1', title: 'Plans' }, { operationId: 'op_1', title: 'Plans' }]);
  });

  it('pages the timeline with an opaque cursor and bounded limit', async () => {
    const { substrate, calls } = harness(() => json(200, { events: [event('e1'), event('e2', agent)], nextCursor: 'c2', revision: '3' }));
    const page = await substrate.timeline({ roomId: CHANNEL, cursor: 'c1', limit: 50 });
    expect(page).toMatchObject({ kind: 'done', value: { nextCursor: 'c2', revision: '3' } });
    expect(page.kind === 'done' && page.value.events.map(entry => entry.kind === 'message' && entry.participant.displayName)).toEqual(['You', 'Codex']);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/v1/channels/ch_one/timeline?cursor=c1&limit=50`);
  });
});

describe('HttpRoomSubstrate hint stream', () => {
  function live(pages: Array<Readonly<{ events: unknown[]; nextCursor: string | null }>>, streams: Stream[], hintStatus = 200) {
    return harness(call => {
      if (call.url.endsWith('/hints')) {
        if (hintStatus !== 200) return json(hintStatus, { error: { code: 'x' } });
        const stream = new Stream();
        streams.push(stream);
        return new Response(stream.body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      }
      if (call.url.includes('/timeline')) {
        const cursor = new URL(call.url).searchParams.get('cursor');
        const found = cursor === null ? pages[0] : pages.find((_, index) => pages[index - 1]?.nextCursor === cursor);
        return json(200, { ...found, revision: '3' });
      }
      return json(200, { channel, participants: [human, agent] });
    });
  }

  it('reads hints through fetch, publishes the current state and goes live', async () => {
    const streams: Stream[] = [];
    const { substrate, calls, states } = live([{ events: [event('e1')], nextCursor: null }], streams);
    const updates: SubstrateUpdate[] = [];
    substrate.subscribe(CHANNEL, update => updates.push(update));
    await settle();
    expect(calls[0]).toMatchObject({ url: `${ORIGIN}/api/v1/channels/ch_one/hints`, headers: { [REQUEST_SECRET_HEADER]: SECRET, accept: 'text/event-stream' } });
    streams[0]!.send('retry: 2000\n\nevent: ready\ndata: {}\n\n');
    await settle(); await settle();
    expect(states).toEqual([{ kind: 'live' }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ generation: 7, room: { roomId: CHANNEL }, events: [{ eventId: 'e1' }] });
  });

  it('walks older pages over a gap until it meets published events', async () => {
    const streams: Stream[] = [];
    const pages: Array<{ events: unknown[]; nextCursor: string | null }> = [{ events: [event('e1')], nextCursor: null }];
    const { substrate } = live(pages, streams);
    const updates: SubstrateUpdate[] = [];
    substrate.subscribe(CHANNEL, update => updates.push(update));
    await settle();
    streams[0]!.send('event: ready\ndata: {}\n\n');
    await settle(); await settle();
    pages.splice(0, 1, { events: [event('e4'), event('e5')], nextCursor: 'older' }, { events: [event('e1'), event('e2'), event('e3')], nextCursor: null });
    streams[0]!.send('event: hint\ndata: {}\n\n');
    await settle(); await settle(); await settle();
    expect(updates.at(-1)!.events.map(entry => entry.eventId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('reconnects with bounded backoff, then stops, and restarts on retry', async () => {
    const streams: Stream[] = [];
    const { substrate, states, fire } = live([{ events: [], nextCursor: null }], streams);
    substrate.subscribe(CHANNEL, () => undefined);
    await settle();
    streams[0]!.send('event: ready\ndata: {}\n\n');
    await settle();
    streams[0]!.end();
    await settle(); await settle();
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', attempt: 1 });
    fire(10);
    await settle();
    streams[1]!.end();
    await settle(); await settle();
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', attempt: 2 });
    fire(20);
    await settle();
    streams[2]!.end();
    await settle(); await settle();
    expect(states.at(-1)).toEqual({ kind: 'stopped' });
    substrate.transport.retry();
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'connecting' });
    streams[3]!.send('event: ready\ndata: {}\n\n');
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'live' });
  });

  it('never reconnects a stream whose credential was refused', async () => {
    const { substrate, states, calls } = live([], [], 401);
    substrate.subscribe(CHANNEL, () => undefined);
    await settle(); await settle();
    expect(states).toEqual([{ kind: 'auth_failed' }]);
    expect(calls).toHaveLength(1);
  });

  it('stops publishing after unsubscribe', async () => {
    const streams: Stream[] = [];
    const { substrate } = live([{ events: [event('e1')], nextCursor: null }], streams);
    const updates: SubstrateUpdate[] = [];
    const release = substrate.subscribe(CHANNEL, update => updates.push(update));
    await settle();
    release();
    streams[0]!.send('event: ready\ndata: {}\n\n');
    await settle(); await settle();
    expect(updates).toEqual([]);
  });
});

describe('readHintStream', () => {
  it('parses frames split across chunks, CRLF and keepalive comments', async () => {
    const stream = new Stream();
    const frames: string[] = [];
    let activity = 0;
    const done = readHintStream(stream.body, frame => frames.push(frame), () => { activity += 1; });
    stream.send('retry: 2000\r\n\r\nevent: re');
    stream.send('ady\ndata: {}\n\n: keepalive\n\nevent: hint\ndata: {}\n\nevent: other\n\n');
    stream.end();
    await done;
    expect(frames).toEqual(['ready', 'hint']);
    expect(activity).toBe(2);
  });

  it('rejects an unbounded frame', async () => {
    const stream = new Stream();
    const done = readHintStream(stream.body, () => undefined, () => undefined);
    stream.send('x'.repeat(5000));
    await expect(done).rejects.toThrow('too large');
  });
});
