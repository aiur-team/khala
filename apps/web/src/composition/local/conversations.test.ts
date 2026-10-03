import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type LocalChannelSummary, type LocalEvent } from '@khala/contracts/m1/local';
import { decodeRoomId, decodeOwnerId } from '@khala/contracts/messaging/ids';
import type { LocalHttp, LocalHttpResult } from './http';
import { createLocalConversations, LAST_SEEN_KEY_PREFIX, type LocalConversations } from './conversations';

const room = decodeRoomId('!c7Kq2vXbT1nP0aZ9yW3eQw:local');
if (!room.ok) throw new Error('fixture room');
const roomId = room.value;
const decodedOwner = decodeOwnerId(LOCAL_OWNER_ID);
const decodedOther = decodeOwnerId('other');
if (!decodedOwner.ok || !decodedOther.ok) throw new Error('fixture owners');
const ownerId = decodedOwner.value;
const otherOwnerId = decodedOther.value;
const agentId = '@agent-b2c3d4e5:local';
const summary: LocalChannelSummary = {
  roomId, name: 'refactor', createdAt: '2025-10-02T09:00:01.000Z', lastSeq: 8, lastTs: 1759395700000,
  preview: 'On it.', lastSender: { userId: agentId, displayName: 'kevin-Codex' }, members: [
    { userId: LOCAL_OWNER_USER_ID, displayName: 'kevin', kind: 'human' },
    { userId: '@agent-a1b2c3d4:local', displayName: 'kevin-Claude', kind: 'agent', harness: 'claude' },
    { userId: agentId, displayName: 'kevin-Codex', kind: 'agent', harness: 'codex' },
  ],
};
function event(seq: number, sender: string = agentId, type: LocalEvent['type'] = 'm.room.message'): LocalEvent {
  return { seq, sender, type, roomId, eventId: `$${String(seq).padStart(22, '0')}`, ts: summary.lastTs,
    content: type === 'm.room.message' ? { msgtype: 'm.text', body: 'hi' } : { name: 'renamed' } };
}
const page = (events: LocalEvent[]) => ({ events, next: events.at(-1)?.seq ?? 0 });
const active: LocalConversations[] = [];
afterEach(() => { for (const port of active.splice(0)) port.dispose(); vi.useRealTimers(); });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(options?: { initialSeen?: string | undefined; storage?: Pick<Storage, 'getItem' | 'setItem'> | null }) {
  const requests: { path: string; signal: AbortSignal | undefined; timeoutMs: number | undefined;
    answer(result: LocalHttpResult<unknown>): void }[] = [];
  const data = new Map<string, string>();
  if (options?.initialSeen !== undefined) data.set(LAST_SEEN_KEY_PREFIX + roomId, options.initialSeen);
  const storage = options?.storage === undefined ? { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); } } : options.storage;
  const http: LocalHttp = { origin: 'http://localhost:47830',
    get: (path, decode, signal, timeoutMs) => new Promise(resolve => {
      requests.push({ path, signal, timeoutMs, answer(result) {
        if (result.kind !== 'ok') { resolve(result); return; }
        const decoded = decode(result.value);
        resolve(decoded.ok ? { kind: 'ok', value: decoded.value } : { kind: 'error', status: 200, code: 'invalid_response' });
      } });
    }),
    send: async () => { throw new Error('unexpected mutation'); },
  };
  const port = createLocalConversations(http, { storage }); active.push(port);
  const snapshot = () => port.snapshot(ownerId, 1);
  const polls = () => requests.filter(r => r.path.startsWith('/api/local/channels?'));
  const unread = () => requests.filter(r => r.path.includes('/events?'));
  async function list(channels: LocalChannelSummary[] = [summary], revision = 42) {
    polls().at(-1)!.answer({ kind: 'ok', value: { revision, channels } }); await flush();
  }
  return { port, requests, snapshot, polls, unread, list, data };
}

describe('local conversations', () => {
  it('distinguishes initial loading and error, then recovers through retry', async () => {
    vi.useFakeTimers(); const s = setup(); const listener = vi.fn();
    expect(s.snapshot()).toBeUndefined(); s.port.subscribe(ownerId, 1, listener);
    expect(s.polls()[0]).toMatchObject({ path: '/api/local/channels?wait=25', timeoutMs: 35_000 });
    s.polls()[0]!.answer({ kind: 'unavailable' }); await flush();
    expect(s.snapshot()).toBeNull(); expect(s.port.syncStatus.live(ownerId, 1)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(s.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(s.polls()).toHaveLength(2);
    await s.list([]); expect(s.snapshot()).toEqual([]);
    expect(s.port.syncStatus.live(ownerId, 1)).toBe(true);
    expect(s.polls().at(-1)?.path).toBe('/api/local/channels?since=42&wait=25');
  });
  it('maps every channel, avatars and latest sender and sorts by activity', async () => {
    const s = setup({ initialSeen: '5' }); s.snapshot(); await s.list();
    expect(s.unread()[0]?.path).toBe('/api/local/rooms/!c7Kq2vXbT1nP0aZ9yW3eQw%3Alocal/events?after=5&wait=0');
    s.unread()[0]!.answer({ kind: 'ok', value: page([event(6, LOCAL_OWNER_USER_ID), event(7), event(8, agentId, 'm.room.name')]) });
    await flush();
    expect(s.snapshot()).toEqual([{ id: roomId, title: 'refactor', preview: 'On it.', timestamp: '2025-10-02T09:01:40.000Z',
      unreadCount: 1, members: [
        { id: '@agent-a1b2c3d4:local', kind: 'agent', displayName: 'kevin-Claude', ownerId: LOCAL_OWNER_ID, harness: 'claude' },
        { id: agentId, kind: 'agent', displayName: 'kevin-Codex', ownerId: LOCAL_OWNER_ID, harness: 'codex' },
      ], lastSender: { label: 'kevin-Codex', isViewer: false } }]);
    const empty = { ...summary, roomId: '!abcdefghijklmnopqrstuv:local', name: 'empty', preview: null,
      members: [{ userId: agentId, displayName: 'agent', kind: 'agent' as const }] };
    await s.list([empty, summary], 43);
    expect(s.snapshot()?.map(item => item.id)).toEqual([roomId, empty.roomId]);
    expect(s.snapshot()?.[1]).toEqual({ id: empty.roomId, title: 'empty', preview: null, timestamp: null,
      unreadCount: null, members: [{ id: agentId, displayName: 'agent', kind: 'agent', ownerId: LOCAL_OWNER_ID }] });
  });
  it('keeps the same snapshot on identical polls or outages and caps/reset backoff', async () => {
    vi.useFakeTimers(); const s = setup({ initialSeen: '8' }); s.snapshot(); await s.list();
    const previous = s.snapshot(); await s.list(); expect(s.snapshot()).toBe(previous);
    const listener = vi.fn(); const remove = s.port.syncStatus.subscribe(ownerId, 1, listener);
    for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
      const before = s.polls().length; s.polls().at(-1)!.answer({ kind: 'unavailable' }); await flush();
      expect(s.snapshot()).toBe(previous); expect(s.port.syncStatus.live(ownerId, 1)).toBe(false);
      await vi.advanceTimersByTimeAsync(delay - 1); expect(s.polls()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1); expect(s.polls()).toHaveLength(before + 1);
    }
    await s.list(); expect(s.port.syncStatus.live(ownerId, 1)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    s.polls().at(-1)!.answer({ kind: 'unavailable' }); await flush();
    const count = s.polls().length; await vi.advanceTimersByTimeAsync(1000); expect(s.polls()).toHaveLength(count + 1);
    remove();
  });
  it('reads unread once per sequence and retains a previous count until a new answer', async () => {
    const s = setup({ initialSeen: '5' }); s.snapshot(); await s.list();
    s.unread()[0]!.answer({ kind: 'ok', value: page([event(6), event(7, LOCAL_OWNER_USER_ID), event(8)]) }); await flush();
    expect(s.snapshot()?.[0]?.unreadCount).toBe(2);
    const previous = s.snapshot(); await s.list(); expect(s.unread()).toHaveLength(1); expect(s.snapshot()).toBe(previous);
    await s.list([{ ...summary, lastSeq: 9 }], 43); expect(s.unread()).toHaveLength(2);
    expect(s.snapshot()?.[0]?.unreadCount).toBe(2);
    s.unread()[1]!.answer({ kind: 'ok', value: page([event(6), event(7), event(8), event(9)]) }); await flush();
    expect(s.snapshot()?.[0]?.unreadCount).toBe(4); expect(s.snapshot()).not.toBe(previous);
  });
  it.each([undefined, '-1', '1.5', 'NaN', '9007199254740992'])('defaults invalid last-seen %s to zero', async initialSeen => {
    const s = setup({ initialSeen }); s.snapshot(); await s.list();
    expect(s.unread()[0]?.path).toContain('after=0&wait=0');
  });
  it('caps unread at one 200-event page and maps zero to null', async () => {
    const s = setup(); s.snapshot(); await s.list([{ ...summary, lastSeq: 300 }]);
    s.unread()[0]!.answer({ kind: 'ok', value: page(Array.from({ length: 200 }, (_, i) => event(i + 1))) }); await flush();
    expect(s.snapshot()?.[0]?.unreadCount).toBe(200);
    await s.list([{ ...summary, lastSeq: 301 }], 43);
    s.unread()[1]!.answer({ kind: 'ok', value: page([event(301, LOCAL_OWNER_USER_ID)]) }); await flush();
    expect(s.snapshot()?.[0]?.unreadCount).toBeNull();
  });
  it('clears unread while viewed and follows latest sequence until all holders release', async () => {
    const s = setup({ initialSeen: '5' }); s.snapshot(); await s.list();
    s.unread()[0]!.answer({ kind: 'ok', value: page([event(8)]) }); await flush();
    const release = s.port.viewing(roomId); const other = s.port.viewing(roomId);
    expect(s.snapshot()?.[0]?.unreadCount).toBeNull(); expect(s.data.get(LAST_SEEN_KEY_PREFIX + roomId)).toBe('8');
    await s.list([{ ...summary, lastSeq: 9 }], 43);
    expect(s.data.get(LAST_SEEN_KEY_PREFIX + roomId)).toBe('9'); expect(s.unread()).toHaveLength(1);
    release(); release(); await s.list([{ ...summary, lastSeq: 10 }], 44);
    expect(s.data.get(LAST_SEEN_KEY_PREFIX + roomId)).toBe('10'); expect(s.unread()).toHaveLength(1);
    other(); await s.list([{ ...summary, lastSeq: 11 }], 45);
    expect(s.unread()).toHaveLength(2); expect(s.unread()[1]?.path).toContain('after=10&wait=0');
  });
  it('ignores late unread answers after viewing or a newer summary', async () => {
    const s = setup(); s.snapshot(); await s.list();
    await s.list([{ ...summary, lastSeq: 9 }], 43);
    expect(s.unread()).toHaveLength(2);
    s.unread()[1]!.answer({ kind: 'ok', value: page([event(8), event(9)]) }); await flush();
    s.unread()[0]!.answer({ kind: 'ok', value: page([event(8)]) }); await flush();
    expect(s.snapshot()?.[0]?.unreadCount).toBe(2);
    await s.list([{ ...summary, lastSeq: 10 }], 44);
    const release = s.port.viewing(roomId); release();
    s.unread()[2]!.answer({ kind: 'ok', value: page([event(10)]) }); await flush();
    expect(s.snapshot()?.[0]?.unreadCount).toBeNull();
  });
  it('ignores unread results superseded by own activity or channel deletion', async () => {
    const s = setup(); s.snapshot(); await s.list();
    await s.list([{ ...summary, lastSeq: 9, lastSender: { userId: LOCAL_OWNER_USER_ID, displayName: 'kevin' } }], 43);
    s.unread()[0]!.answer({ kind: 'ok', value: page([event(8)]) }); await flush();
    await s.list([{ ...summary, lastSeq: 10 }], 44);
    expect(s.snapshot()?.[0]?.unreadCount).toBeNull();
    await s.list([], 45);
    s.unread()[1]!.answer({ kind: 'ok', value: page([event(10)]) }); await flush();
    await s.list([{ ...summary, lastSeq: 11 }], 46);
    expect(s.snapshot()?.[0]?.unreadCount).toBeNull();
  });
  it('does not count own activity, already-seen activity or missing senders', async () => {
    const s = setup({ initialSeen: '8' }); s.snapshot(); await s.list(); expect(s.unread()).toHaveLength(0);
    await s.list([{ ...summary, lastSeq: 9, lastSender: { userId: LOCAL_OWNER_USER_ID, displayName: 'kevin' } }], 43);
    expect(s.snapshot()?.[0]?.lastSender).toEqual({ label: 'kevin', isViewer: true });
    expect(s.snapshot()?.[0]?.unreadCount).toBeNull(); expect(s.unread()).toHaveLength(0);
    const { lastSender: _sender, ...noSender } = summary; void _sender;
    await s.list([{ ...noSender, lastSeq: 10 }], 44); expect(s.unread()).toHaveLength(0);
  });
  it('does not retry a failed unread read for the same sequence', async () => {
    const s = setup(); s.snapshot(); await s.list();
    s.unread()[0]!.answer({ kind: 'unavailable' }); await flush();
    await s.list(); expect(s.unread()).toHaveLength(1); expect(s.snapshot()?.[0]?.unreadCount).toBeNull();
  });
  it.each([null, { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } }])(
    'keeps viewing markers when storage is unavailable', async storage => {
      const s = setup({ storage }); const release = s.port.viewing(roomId); s.snapshot(); await s.list();
      expect(s.unread()).toHaveLength(0); release(); await s.list([{ ...summary, lastSeq: 9 }], 43);
      expect(s.unread()[0]?.path).toContain('after=8&wait=0');
    });
  it('isolates owners, subscribers and disposal of pending polls and unread reads', async () => {
    const s = setup(); expect(s.port.snapshot(otherOwnerId, 1)).toBeNull();
    s.port.subscribe(otherOwnerId, 1, vi.fn()); expect(s.requests).toHaveLength(0);
    expect(s.port.syncStatus.live(otherOwnerId, 1)).toBe(false);
    s.port.subscribe(ownerId, 1, () => { throw new Error('subscriber'); });
    await s.list(); const previous = s.snapshot(); const listener = vi.fn(); s.port.subscribe(ownerId, 1, listener);
    s.port.dispose(); expect(s.polls().at(-1)?.signal?.aborted).toBe(true); expect(s.unread()[0]?.signal?.aborted).toBe(true);
    s.polls().at(-1)!.answer({ kind: 'ok', value: { revision: 43, channels: [] } });
    s.unread()[0]!.answer({ kind: 'ok', value: page([event(8)]) }); await flush();
    expect(s.snapshot()).toBe(previous); expect(s.polls()).toHaveLength(2); expect(listener).not.toHaveBeenCalled();
  });
  it('aborts an active backoff and never resumes polling', async () => {
    vi.useFakeTimers(); const s = setup(); s.snapshot(); s.polls()[0]!.answer({ kind: 'unavailable' }); await flush();
    s.port.dispose(); await vi.advanceTimersByTimeAsync(10_000); expect(s.polls()).toHaveLength(1);
  });
});
