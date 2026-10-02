import { ChannelProjection, toEntry } from './timeline';
import { createHash } from 'node:crypto'; // Channel projection fixtures use stable wire IDs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventId, type EventRef, type MessageContent, type ChannelSnapshot, digestMessageContent } from '@khala/contracts/messaging/index';
import type { ChannelEntriesView } from './index';
import type { SubstrateEvent } from './substrate';
import { deviceId, harness, human, settle, text } from './fixtures/fakes';

// `digestMessageContent` awaits the platform's real `crypto.subtle.digest`, which Node
// backs with the libuv threadpool. Its completion depends on thread-pool contention, not
// just microtask ordering, so it can outlast the single `settle()` tick these tests budget
// on a busy shared runner. Replace only `digest` on the real `SubtleCrypto` instance for the
// duration of this file (same SHA-256 bytes, resolved on the microtask queue instead) and
// restore it after every test, so other suites keep the genuine threadpool-backed digest.
let digestSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (algorithm !== 'SHA-256') return nativeDigest(algorithm, data);
    const hash = createHash('sha256').update(data as Uint8Array).digest();
    return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
  });
});

afterEach(() => {
  digestSpy.mockRestore();
});

const message = (eventId: string, body: string, clientTxnId: string | null = null): SubstrateEvent => ({
  kind: 'message', eventId: eventId as EventId, authorDeviceId: deviceId, participant: human, content: text(body), clientTxnId,
  receivedAt: '2026-09-17T00:00:01Z',
});

function observed() {
  const h = harness();
  const room = h.substrate.addRoom({ title: 'Chat' });
  const snapshots: ChannelSnapshot[] = [];
  const views: ChannelEntriesView[] = [];
  h.service.observe(room.roomId, snapshot => snapshots.push(snapshot));
  h.service.observeEntries(room.roomId, view => views.push(view));
  const emit = (events: SubstrateEvent[], generation = 1) => h.substrate.emit(room.roomId, { generation, room, events });
  return { ...h, room, snapshots, views, emit, last: () => snapshots.at(-1), lastView: () => views.at(-1) };
}

describe('timeline projection', () => {
  it('shows one item when the remote echo arrives before the send response', async () => {
    const t = observed();
    t.emit([]);
    t.substrate.sendMode = () => 'accept';
    const pending = t.service.send({ roomId: t.room.roomId, clientTxnId: 'c-1', content: text('hello') });
    // The echo lands while the send call is still outstanding.
    t.emit([message('$event-1', 'hello', 'c-1')]);
    await pending;
    await settle();
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$event-1']);
    expect(t.lastView()?.entries.map(entry => entry.kind)).toEqual(['message']);
  });

  it('shows one item when the send response arrives before the remote echo', async () => {
    const t = observed();
    t.emit([]);
    await t.service.send({ roomId: t.room.roomId, clientTxnId: 'c-1', content: text('hello') });
    await settle();
    expect(t.last()?.items).toHaveLength(1);
    t.emit([message('$event-1', 'hello', 'c-1')]);
    await settle();
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$event-1']);
  });

  it('shows an unechoed failed send as a local entry, not a timeline item', async () => {
    const t = observed();
    t.emit([]);
    t.substrate.sendMode = () => 'unavailable';
    await t.service.send({ roomId: t.room.roomId, clientTxnId: 'c-1', content: text('hello') });
    await settle();
    expect(t.last()?.items).toEqual([]);
    expect(t.lastView()?.entries).toEqual([{ kind: 'local', send: { clientTxnId: 'c-1', state: 'failed', eventRef: null }, content: text('hello') }]);
  });

  it('dedupes duplicate and out-of-order sync events by event ID', async () => {
    const t = observed();
    t.emit([message('$b', 'second'), message('$a', 'first')]);
    t.emit([message('$a', 'first'), message('$b', 'second'), message('$c', 'third')]);
    await settle();
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$b', '$a', '$c']);
  });

  it('binds every item reference to the exact content digest', async () => {
    const t = observed();
    t.emit([message('$a', 'Hi\u2028there')]);
    await settle();
    const digest = await digestMessageContent(text('Hi\u2028there'));
    expect((t.last()?.items[0]?.ref as EventRef | undefined)?.contentDigest).toBe(digest.ok ? digest.digest : 'unreachable');
  });

  it('shows an explicit placeholder for an undecryptable event and replaces it once decrypted', async () => {
    const t = observed();
    t.emit([{ kind: 'undecryptable', eventId: '$x' as EventId, authorParticipantId: human.participantId, reason: 'missing_key', receivedAt: '2026-09-17T00:00:01Z' }]);
    await settle();
    expect(t.last()?.items).toEqual([]);
    expect(t.lastView()?.entries).toEqual([
      { kind: 'unavailable', eventId: '$x', authorParticipantId: human.participantId, reason: 'missing_key', receivedAt: '2026-09-17T00:00:01Z' },
    ]);
    t.emit([message('$x', 'now readable')]);
    await settle();
    expect(t.last()?.items.map(item => (item.content as MessageContent).body)).toEqual(['now readable']);
  });

  it('never downgrades a decrypted event when a replay cannot decrypt it', async () => {
    const t = observed();
    t.emit([message('$a', 'readable')]);
    t.emit([{ kind: 'undecryptable', eventId: '$a' as EventId, authorParticipantId: human.participantId, reason: 'missing_key', receivedAt: '2026-09-17T00:00:02Z' }]);
    await settle();
    expect(t.lastView()?.entries.map(entry => entry.kind)).toEqual(['message']);
  });

  it('ignores updates from an old lifecycle generation', async () => {
    const t = observed();
    t.emit([message('$a', 'current')]);
    t.emit([message('$old', 'stale')], 0);
    await settle();
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$a']);
    expect(t.snapshots.every(snapshot => snapshot.generation === 1)).toBe(true);
  });

  it('starts a new lifecycle generation from an empty projection', async () => {
    const t = observed();
    t.emit([message('$old', 'from the previous device')]);
    await settle();
    t.device.view = { ...t.device.view, generation: 2 };
    t.emit([message('$new', 'from the replacement')], 2);
    await settle();
    expect(t.last()).toMatchObject({ generation: 2 });
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$new']);
  });

  it('keeps delivering to other observers and later updates when one observer throws', async () => {
    const t = observed();
    t.service.observe(t.room.roomId, () => {
      throw new Error('observer bug');
    });
    t.emit([message('$a', 'one')]);
    await settle();
    t.emit([message('$b', 'two')]);
    await settle();
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$a', '$b']);
    // Entry observers are notified after the throwing snapshot observer.
    expect(t.lastView()?.entries).toHaveLength(2);
    expect(t.listenerErrors).toHaveLength(2);
  });

  it('keeps accepted history when membership is revoked', async () => {
    const t = observed();
    t.emit([message('$a', 'before')]);
    t.substrate.emit(t.room.roomId, { generation: 1, room: { ...t.room, membership: 'revoked' }, events: [] });
    await settle();
    expect(t.last()?.room.membership).toBe('revoked');
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$a']);
  });
});

describe('timeline page', () => {
  it('maps decrypted events, dedupes them and passes the cursor through opaquely', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.page = {
      kind: 'done',
      value: {
        events: [
          message('$a', 'one'), message('$a', 'one'),
          { kind: 'undecryptable', eventId: '$x' as EventId, authorParticipantId: human.participantId, reason: 'decryption_failed', receivedAt: '2026-09-17T00:00:01Z' },
          message('$b', 'two'),
        ],
        nextCursor: 'opaque/cursor==',
        revision: 'rev-9',
      },
    };
    const page = await service.timeline({ roomId: room.roomId, cursor: null, limit: 20 });
    expect(page).toMatchObject({ kind: 'ok', value: { nextCursor: 'opaque/cursor==', snapshotRevision: 'rev-9', unavailableEventIds: ['$x'] } });
    if (page.kind === 'ok') expect(page.value.items.map(item => item.ref.eventId)).toEqual(['$a', '$b']);
  });

  it('keeps the decrypted copy when a page holds a placeholder and the message for one event', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.page = {
      kind: 'done',
      value: {
        events: [
          { kind: 'undecryptable', eventId: '$a' as EventId, authorParticipantId: human.participantId, reason: 'missing_key', receivedAt: '2026-09-17T00:00:01Z' },
          message('$a', 'readable'),
        ],
        nextCursor: null,
        revision: 'rev-1',
      },
    };
    const page = await service.timeline({ roomId: room.roomId, cursor: null, limit: 20 });
    expect(page.kind === 'ok' && page.value.items.map(item => (item.content as MessageContent).body)).toEqual(['readable']);
  });

  it('rejects invalid page requests and maps substrate failures', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    expect(await service.timeline({ roomId: room.roomId, cursor: null, limit: 0 })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(await service.timeline({ roomId: room.roomId, cursor: '', limit: 10 })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    substrate.page = { kind: 'rejected', code: 'not_joined' };
    expect(await service.timeline({ roomId: room.roomId, cursor: null, limit: 10 })).toEqual({ kind: 'rejected', code: 'not_joined' });
    substrate.page = { kind: 'unavailable' };
    expect(await service.timeline({ roomId: room.roomId, cursor: null, limit: 10 })).toEqual({ kind: 'unavailable', retryable: true });
  });
});


it('identifies paginated ciphertext in entries even when its publication follows the history response', async () => {
  const t = observed();
  const historical: SubstrateEvent = { kind: 'undecryptable', eventId: '$historical' as EventId,
    authorParticipantId: human.participantId, reason: 'missing_key', receivedAt: '2026-09-17T00:00:01Z' };
  t.emit([message('$current', 'current')]);
  await settle();
  t.substrate.page = { kind: 'done', value: { events: [historical], nextCursor: null, revision: 'history' } };
  const page = await t.service.timeline({ roomId: t.room.roomId, cursor: null, limit: 20 });
  expect(page.kind === 'ok' && page.value.items).toEqual([]);
  t.emit([historical, message('$live-same-time', 'live')]);
  await settle();
  expect(t.lastView()?.historicalEventIds).toEqual(['$historical']);
  expect(t.lastView()?.entries).toHaveLength(3);
  t.device.view = { ...t.device.view, generation: 2 };
  t.emit([message('$new-generation', 'fresh')], 2);
  await settle();
  expect(t.lastView()?.historicalEventIds).toEqual([]);
});


describe('channel events in entries', () => {
  const event = { kind: 'channel_event' as const, eventId: '$channel-event' as EventId, participant: human,
    content: { v: 1 as const, body: 'deployed', kind: 'deploy.finished', summary: 'deployed' }, receivedAt: '2026-10-01T10:09:30Z' };
  it('passes through without a message digest and excludes events from pages and snapshots', async () => {
    const t = observed();
    expect(await toEntry(t.room.roomId, event)).toEqual(event);
    t.emit([event, message('$message', 'hello')]);
    await settle();
    expect(t.lastView()?.entries.map(entry => entry.kind)).toEqual(['channel_event', 'message']);
    expect(t.last()?.items.map(item => item.ref.eventId)).toEqual(['$message']);
    t.substrate.page = { kind: 'done', value: { events: [event, message('$message', 'hello')], nextCursor: null, revision: 'events' } };
    const page = await t.service.timeline({ roomId: t.room.roomId, cursor: null, limit: 50 });
    expect(page.kind).toBe('ok');
    if (page.kind === 'ok') expect(page.value.items.every(item => item.ref.eventId !== event.eventId)).toBe(true);
  });
  it('replaces unavailable entries after decryption and never regresses to ciphertext', () => {
    const projection = new ChannelProjection('room_event' as never, human, () => event.receivedAt);
    const unavailable = { kind: 'unavailable' as const, eventId: event.eventId,
      authorParticipantId: human.participantId, reason: 'missing_key' as const, receivedAt: event.receivedAt };
    projection.applyRemote([unavailable]);
    projection.applyRemote([event]);
    expect(projection.entries(1).entries).toEqual([event]);
    projection.applyRemote([unavailable]);
    expect(projection.entries(1).entries).toEqual([event]);
  });
});

it('inserts newly paginated events before the known following timeline event', () => {
  const projection = new ChannelProjection('room_events' as never, human, () => '2026-10-01T00:00:00Z');
  const event = (id: string) => ({ kind: 'channel_event' as const, eventId: id as EventId, participant: human,
    content: { v: 1 as const, body: id, kind: 'deploy.finished', summary: id, key: 'same' }, receivedAt: '2026-10-01T00:00:00Z' });
  projection.applyRemote([event('$newer')]);
  projection.applyRemote([event('$older'), event('$newer')]);
  expect(projection.entries(1).entries.map(entry => entry.kind === 'message' ? entry.item.ref.eventId : entry.kind === 'local' ? null : entry.eventId))
    .toEqual(['$older', '$newer']);
});

it('removes unavailable rows when decrypted channel events are ignored', () => {
  const projection = new ChannelProjection('room_events' as never, human, () => '2026-10-01T00:00:00Z');
  const eventId = '$invalid' as EventId;
  projection.applyRemote([{ kind: 'unavailable', eventId, authorParticipantId: human.participantId,
    reason: 'missing_key', receivedAt: '2026-10-01T00:00:00Z' }]);
  projection.applyRemote([], [eventId]);
  expect(projection.entries(1).entries).toEqual([]);
  expect(projection.entries(1).ignoredEventIds).toEqual([eventId]);
});

it('propagates ignored decrypted IDs through the service entries observer', async () => {
  const t = observed();
  const eventId = '$malformed' as EventId;
  t.emit([{ kind: 'undecryptable', eventId, authorParticipantId: human.participantId,
    reason: 'missing_key', receivedAt: '2026-10-01T00:00:00Z' }]);
  await settle();
  expect(t.lastView()?.entries.map(entry => entry.kind)).toEqual(['unavailable']);
  t.substrate.emit(t.room.roomId, { generation: 1, room: t.room, events: [], ignoredEventIds: [eventId] });
  await settle();
  expect(t.lastView()?.entries).toEqual([]);
  expect(t.lastView()?.ignoredEventIds).toEqual([eventId]);
});
