import { describe, expect, it } from 'vitest';
import { type EventId, type RoomSnapshot, digestMessageContent } from '@khala/contracts/messaging/index';
import type { RoomEntriesView } from './index';
import type { SubstrateEvent } from './substrate';
import { deviceId, harness, human, settle, text } from './fixtures/fakes';

const message = (eventId: string, body: string, clientTxnId: string | null = null): SubstrateEvent => ({
  kind: 'message', eventId: eventId as EventId, authorDeviceId: deviceId, participant: human, content: text(body), clientTxnId,
  receivedAt: '2026-09-17T00:00:01Z',
});

function observed() {
  const h = harness();
  const room = h.substrate.addRoom({ title: 'Chat' });
  const snapshots: RoomSnapshot[] = [];
  const views: RoomEntriesView[] = [];
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
    t.emit([message('$a', 'Hi there')]);
    await settle();
    const digest = await digestMessageContent(text('Hi there'));
    expect(t.last()?.items[0]?.ref.contentDigest).toBe(digest.ok ? digest.digest : 'unreachable');
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
    expect(t.last()?.items.map(item => item.content.body)).toEqual(['now readable']);
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
    expect(page).toMatchObject({ kind: 'ok', value: { nextCursor: 'opaque/cursor==', snapshotRevision: 'rev-9' } });
    if (page.kind === 'ok') expect(page.value.items.map(item => item.ref.eventId)).toEqual(['$a', '$b']);
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
