import { describe, expect, it } from 'vitest';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelPort, ChannelSnapshot, TimelineItem } from '@khala/contracts/messaging/index';
import { ok, rejected, unavailable, type Disposer } from '@khala/contracts/messaging/outcomes';
import type { ChannelEntriesView } from '@khala/messaging/channels/index';
import { createTimelineController } from './controller';

const roomId = 'room_demo' as RoomId;

function participant(id: string, displayName: string) {
  return {
    participantId: id as ParticipantId,
    kind: 'human' as const,
    ownerId: `owner_${id}` as OwnerId,
    displayName,
    deviceIds: [] as DeviceId[],
  };
}

function item(eventId: string, authorId: string, body: string, receivedAt = '2026-09-17T00:00:00Z'): TimelineItem {
  return {
    ref: {
      v: 1,
      roomId,
      eventId: eventId as EventId,
      authorParticipantId: authorId as ParticipantId,
      authorDeviceId: `device_${authorId}` as DeviceId,
      contentDigest: `sha256:${'0'.repeat(64)}`,
    },
    content: { v: 1, kind: 'text', body },
    participant: participant(authorId, authorId),
    clientTxnId: null,
    receivedAt,
  };
}

/** A minimal fake exposing only the two operations the controller calls. */
function fakeChannelPort(pages: Record<string, TimelineItem[]> = {}): { port: ChannelPort; emit: (snapshot: ChannelSnapshot) => void; listenerCount: () => number } {
  const listeners = new Set<(snapshot: ChannelSnapshot) => void>();
  const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
    observe: (_roomId, listener): Disposer => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    timeline: async ({ cursor }) => {
      const items = pages[cursor ?? 'first'] ?? [];
      return ok({ items, nextCursor: null, snapshotRevision: 'rev_1' });
    },
  };
  return {
    port: port as ChannelPort,
    emit: snapshot => listeners.forEach(listener => listener(snapshot)),
    listenerCount: () => listeners.size,
  };
}

const room = { roomId, title: null, membership: 'joined' as const, revision: 'rev_1' };

describe('createTimelineController', () => {
  it('does not declare name replay complete when a paginated rename remains undecryptable', async () => {
    const port = { observe: () => () => {}, timeline: async () => ok({ items: [item('after', 'alice', 'after rename')],
      nextCursor: null, snapshotRevision: 'rev_1', unavailableEventIds: ['$missing-rename' as EventId] }) } as unknown as ChannelPort;
    const controller = createTimelineController(port, roomId, { generation: 1 });
    await controller.loadOlder();
    await controller.scanNameHistory?.();
    expect(controller.getSnapshot().namesReady).toBe(false);
    expect(controller.getSnapshot().nameScan).toBe('unavailable');
    expect(controller.getSnapshot().phase).toBe('partial');
    controller.dispose();
  });

  it('restores complete name replay when late keys resolve an unavailable historical event', async () => {
    const fake = fakeChannelPort();
    let emit!: (view: ChannelEntriesView) => void;
    const controller = createTimelineController({ ...fake.port, observeEntries: (_roomId, listener) => {
      emit = listener; return () => {};
    } }, roomId, { generation: 1 });
    const missing = { kind: 'unavailable' as const, eventId: '$rename' as EventId,
      authorParticipantId: 'alice' as ParticipantId, reason: 'missing_key' as const, receivedAt: '2026-09-17T00:00:00Z' };
    emit({ roomId, room, entries: [missing], historicalEventIds: [missing.eventId], generation: 1, snapshotRevision: 'missing' });
    await controller.loadOlder();
    await controller.scanNameHistory?.();
    expect(controller.getSnapshot().namesReady).toBe(false);
    expect(controller.getSnapshot().nameScan).toBe('unavailable');
    const restored = item('$rename', 'alice', 'restored');
    emit({ roomId, room, entries: [{ kind: 'message', item: restored }], historicalEventIds: [missing.eventId], generation: 1, snapshotRevision: 'restored' });
    expect(controller.getSnapshot().namesReady).toBe(true);
    expect(controller.getSnapshot().nameScan).toBe('ready');
    expect(controller.getSnapshot().phase).toBe('ready');
    controller.dispose();
  });

  it('scans older history for name replay without expanding visible pagination', async () => {
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: () => () => {},
      timeline: async ({ cursor }) => cursor === null
        ? ok({ items: [item('E3', 'alice', 'third'), item('E4', 'alice', 'fourth')], nextCursor: 'C1', snapshotRevision: 'rev_1' })
        : ok({ items: [item('E1', 'alice', 'first'), item('E2', 'alice', 'second')], nextCursor: null, snapshotRevision: 'rev_1' }),
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1, pageSize: 2 });
    await controller.loadOlder();
    await controller.scanNameHistory?.();
    expect(controller.getSnapshot().items.map(entry => entry.ref.eventId)).toEqual(['E3', 'E4']);
    expect(controller.getSnapshot().nameHistory?.map(entry => entry.ref.eventId)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(controller.getSnapshot().namesReady).toBe(true);
    expect(controller.getSnapshot().nextCursor).not.toBeNull();
    await controller.loadOlder();
    expect(controller.getSnapshot().items.map(entry => entry.ref.eventId)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(controller.getSnapshot().nextCursor).toBeNull();
    controller.dispose();
  });

  it('stops a name scan when history repeats its cursor', async () => {
    let reads = 0;
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: () => () => {},
      timeline: async ({ cursor }) => {
        reads++;
        return ok({ items: [item('E1', 'alice', 'first')], nextCursor: cursor ?? 'C1', snapshotRevision: 'rev_1' });
      },
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    await controller.loadOlder();
    await controller.scanNameHistory?.();
    expect(reads).toBe(2);
    expect(controller.getSnapshot().phase).toBe('partial');
    expect(controller.getSnapshot().namesReady).toBe(false);
    expect(controller.getSnapshot().nameScan).toBe('retryable');
    controller.dispose();
  });

  it('settles a failed initial read and recovers after retry', async () => {
    let fail = true;
    const port = { observe: () => () => {}, timeline: async () => fail
      ? unavailable()
      : ok({ items: [item('E1', 'alice', 'readable')], nextCursor: null, snapshotRevision: 'rev_1' }) } as unknown as ChannelPort;
    const controller = createTimelineController(port, roomId, { generation: 1 });
    await controller.loadOlder();
    await controller.scanNameHistory?.();
    expect(controller.getSnapshot().nameScan).toBe('retryable');
    fail = false;
    await controller.loadOlder();
    await controller.scanNameHistory?.();
    expect(controller.getSnapshot().nameScan).toBe('ready');
    controller.dispose();
  });

  it('merges an older page and a later live snapshot by event ID, rendering shared items once', async () => {
    const { port, emit } = fakeChannelPort({ first: [item('E1', 'alice', 'first'), item('E2', 'alice', 'second')] });
    const controller = createTimelineController(port, roomId, { generation: 1 });

    await controller.loadOlder();
    emit({ room, items: [item('E2', 'alice', 'second'), item('E3', 'bob', 'third')], snapshotRevision: 'rev_2', generation: 1 });

    const { items } = controller.getSnapshot();
    expect(items.map(entry => entry.ref.eventId)).toEqual(['E1', 'E2', 'E3']);
    controller.dispose();
  });

  it('keeps two records with identical text from different authenticated authors, each with correct ownership', () => {
    const { port, emit } = fakeChannelPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });

    emit({ room, items: [item('E1', 'alice', 'same text'), item('E2', 'bob', 'same text')], snapshotRevision: 'rev_1', generation: 1 });

    const { items } = controller.getSnapshot();
    expect(items).toHaveLength(2);
    expect(items[0]!.ref.eventId).toBe('E1');
    expect(items[0]!.participant.participantId).toBe('alice');
    expect(items[1]!.ref.eventId).toBe('E2');
    expect(items[1]!.participant.participantId).toBe('bob');
    controller.dispose();
  });

  it('ignores a snapshot from a stale generation, and dispose unsubscribes exactly once', () => {
    const { port, emit, listenerCount } = fakeChannelPort();
    const controller = createTimelineController(port, roomId, { generation: 2 });
    expect(listenerCount()).toBe(1);

    emit({ room, items: [item('E1', 'alice', 'stale')], snapshotRevision: 'rev_stale', generation: 1 });
    expect(controller.getSnapshot().items).toEqual([]);

    controller.dispose();
    controller.dispose();
    expect(listenerCount()).toBe(0);

    emit({ room, items: [item('E2', 'alice', 'after dispose')], snapshotRevision: 'rev_after', generation: 2 });
    expect(controller.getSnapshot().items).toEqual([]);
  });

  it('two concurrent loadOlder calls share one request and never duplicate rows', async () => {
    let timelineCalls = 0;
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => {
        timelineCalls += 1;
        return ok({ items: [item('E1', 'alice', 'first'), item('E2', 'alice', 'second')], nextCursor: null, snapshotRevision: 'rev_1' });
      },
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });

    const [first, second] = await Promise.all([controller.loadOlder(), controller.loadOlder()]);
    expect(timelineCalls).toBe(1);
    expect(first).toBe(second);
    expect(controller.getSnapshot().items.map(entry => entry.ref.eventId)).toEqual(['E1', 'E2']);
    controller.dispose();
  });

  it('caches the returned snapshot reference until state actually changes', () => {
    const { port } = fakeChannelPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });
    const first = controller.getSnapshot();
    const second = controller.getSnapshot();
    expect(first).toBe(second);
    controller.dispose();
  });

  it('surfaces an unavailable first page as phase "unavailable" without throwing', async () => {
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => unavailable(),
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    await controller.loadOlder();
    expect(controller.getSnapshot().phase).toBe('unavailable');
    controller.dispose();
  });

  it('resets newMessageCount only once the reader returns to latest', () => {
    const { port, emit } = fakeChannelPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });
    controller.setReaderAtLatest(false);

    emit({ room, items: [item('E1', 'alice', 'one')], snapshotRevision: 'rev_1', generation: 1 });
    expect(controller.getSnapshot().newMessageCount).toBe(1);

    emit({ room, items: [item('E1', 'alice', 'one'), item('E2', 'alice', 'two')], snapshotRevision: 'rev_2', generation: 1 });
    expect(controller.getSnapshot().newMessageCount).toBe(2);

    controller.setReaderAtLatest(true);
    expect(controller.getSnapshot().newMessageCount).toBe(0);
    controller.dispose();
  });

  it('never counts arrivals while the reader is already at latest (the default before any setReaderAtLatest call)', () => {
    const { port, emit } = fakeChannelPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });

    emit({ room, items: [item('E1', 'alice', 'one')], snapshotRevision: 'rev_1', generation: 1 });
    expect(controller.getSnapshot().newMessageCount).toBe(0);
    controller.dispose();
  });

  it('a forbidden first page with no items loaded leaves the room unavailable, never a false-empty "ready"', async () => {
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => rejected('forbidden'),
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    await controller.loadOlder();
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('unavailable');
    expect(snapshot.items).toEqual([]);
    controller.dispose();
  });

  it('a forbidden first page arriving after a live snapshot already showed items reports "partial", not "ready" with the gap hidden', async () => {
    const listeners = new Set<(snapshot: ChannelSnapshot) => void>();
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (_roomId, listener): Disposer => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeline: async () => rejected('forbidden'),
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    listeners.forEach(listener => listener({ room, items: [item('E1', 'alice', 'live')], snapshotRevision: 'rev_1', generation: 1 }));
    expect(controller.getSnapshot().phase).toBe('ready');

    await controller.loadOlder();
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('partial');
    expect(snapshot.items.map(entry => entry.ref.eventId)).toEqual(['E1']);
    controller.dispose();
  });

  it('a forbidden first page reported before any snapshot arrives stays "unavailable" once an empty snapshot arrives — arrival order does not change the outcome', async () => {
    const listeners = new Set<(snapshot: ChannelSnapshot) => void>();
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (_roomId, listener): Disposer => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeline: async () => rejected('forbidden'),
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    await controller.loadOlder();
    expect(controller.getSnapshot().phase).toBe('unavailable');

    // A later, otherwise-unremarkable empty snapshot must not overwrite the
    // known history gap with a false-empty "ready".
    listeners.forEach(listener => listener({ room, items: [], snapshotRevision: 'rev_1', generation: 1 }));
    expect(controller.getSnapshot().phase).toBe('unavailable');
    controller.dispose();
  });

  it('"partial" does not revert to "ready" on the next live message; it clears only once a history read succeeds', async () => {
    const listeners = new Set<(snapshot: ChannelSnapshot) => void>();
    let timelineResult: 'forbidden' | 'ok' = 'forbidden';
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (_roomId, listener): Disposer => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeline: async () => (timelineResult === 'forbidden' ? rejected('forbidden') : ok({ items: [], nextCursor: null, snapshotRevision: 'rev_2' })),
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    listeners.forEach(listener => listener({ room, items: [item('E1', 'alice', 'live')], snapshotRevision: 'rev_1', generation: 1 }));
    await controller.loadOlder();
    expect(controller.getSnapshot().phase).toBe('partial');

    // A later live snapshot with a new item is still a gapped transcript.
    listeners.forEach(listener => listener({ room, items: [item('E1', 'alice', 'live'), item('E2', 'alice', 'newer')], snapshotRevision: 'rev_2', generation: 1 }));
    expect(controller.getSnapshot().phase).toBe('partial');

    // Only a successful history read clears the degraded phase.
    timelineResult = 'ok';
    await controller.loadOlder();
    expect(controller.getSnapshot().phase).toBe('ready');
    controller.dispose();
  });

  it('carries the room membership from the snapshot, including revoked/left', () => {
    const { port, emit } = fakeChannelPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });
    expect(controller.getSnapshot().membership).toBeNull();

    emit({ room: { ...room, membership: 'revoked' }, items: [], snapshotRevision: 'rev_1', generation: 1 });
    expect(controller.getSnapshot().membership).toBe('revoked');
    controller.dispose();
  });

  it('deduplicates an older page against rows already known from an earlier page, never rendering a duplicate row', async () => {
    let call = 0;
    const port: Pick<ChannelPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => {
        call += 1;
        // The second page overlaps the first by event E4 (a flaky backend
        // returning an already-seen boundary row), which must not duplicate.
        if (call === 1) return ok({ items: [item('E5', 'alice', 'five'), item('E4', 'alice', 'four')], nextCursor: 'c1', snapshotRevision: 'rev_1' });
        return ok({ items: [item('E4', 'alice', 'four'), item('E3', 'alice', 'three')], nextCursor: null, snapshotRevision: 'rev_2' });
      },
    };
    const controller = createTimelineController(port as ChannelPort, roomId, { generation: 1 });
    await controller.loadOlder();
    await controller.loadOlder();
    const ids = controller.getSnapshot().items.map(entry => entry.ref.eventId);
    // The overlapping E4 from the second page is dropped, not duplicated; the
    // second page's surviving additions prepend ahead of the first page.
    expect(ids).toEqual(['E3', 'E5', 'E4']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id === 'E4')).toHaveLength(1);
    controller.dispose();
  });
});


describe('unavailable transcript entries', () => {
  it('keeps encrypted events in projection order, replaces late decryptions once, and fences stale updates', async () => {
    const fake = fakeChannelPort({ first: [item('older', 'alice', 'older')] });
    let emit!: (view: ChannelEntriesView) => void;
    let disposed = 0;
    const controller = createTimelineController({ ...fake.port, observeEntries: (_roomId, listener) => {
      emit = listener;
      return () => { disposed += 1; };
    } }, roomId, { generation: 1 });
    const unavailableRow = { kind: 'unavailable' as const, eventId: 'encrypted' as EventId,
      authorParticipantId: 'opaque-untrusted' as ParticipantId, reason: 'missing_key' as const,
      receivedAt: '2026-09-17T00:00:00Z' };
    const publish = (entries: ChannelEntriesView['entries'], generation = 1) => emit({ roomId, room, entries, generation, snapshotRevision: '1' });
    publish([{ kind: 'message', item: item('first', 'alice', 'first') }, unavailableRow,
      { kind: 'message', item: item('last', 'alice', 'last') }]);
    await controller.loadOlder();
    expect(controller.getSnapshot().rows?.map(row => row.kind === 'message' ? row.item.ref.eventId : row.eventId))
      .toEqual(['older', 'first', 'encrypted', 'last']);
    controller.setReaderAtLatest(false);
    publish([{ kind: 'message', item: item('first', 'alice', 'first') }, unavailableRow,
      { kind: 'message', item: item('encrypted', 'alice', 'decrypted') }, { kind: 'message', item: item('last', 'alice', 'last') }]);
    expect(controller.getSnapshot().rows).toHaveLength(4);
    expect(controller.getSnapshot().items.map(row => row.content.kind === 'text' ? row.content.body : null)).toEqual(['older', 'first', 'decrypted', 'last']);
    expect(controller.getSnapshot().newMessageCount).toBe(0);
    publish([], 2);
    expect(controller.getSnapshot().rows).toHaveLength(4);
    controller.dispose(); controller.dispose();
    expect(disposed).toBe(1);
    expect(fake.listenerCount()).toBe(0);
  });
});


it('does not label encrypted history discovered by pagination as new messages', async () => {
  const fake = fakeChannelPort();
  let emit!: (view: ChannelEntriesView) => void;
  const controller = createTimelineController({ ...fake.port,
    observeEntries: (_roomId, listener) => { emit = listener; return () => {}; },
    timeline: async () => {
      emit({ roomId, room, generation: 1, snapshotRevision: 'history', entries: [{ kind: 'unavailable',
        eventId: 'old-encrypted' as EventId, authorParticipantId: 'opaque' as ParticipantId,
        reason: 'missing_key', receivedAt: '2026-09-16T00:00:00Z' }] });
      return ok({ items: [], nextCursor: null, snapshotRevision: 'history' });
    },
  }, roomId, { generation: 1 });
  controller.setReaderAtLatest(false);
  await controller.loadOlder();
  expect(controller.getSnapshot().rows).toHaveLength(1);
  expect(controller.getSnapshot().newMessageCount).toBe(0);
  controller.dispose();
});


it('keeps three initial encrypted events as three rows after one late decryption', () => {
  const fake = fakeChannelPort();
  let emit!: (view: ChannelEntriesView) => void;
  const controller = createTimelineController({ ...fake.port, observeEntries: (_roomId, listener) => {
    emit = listener; return () => {};
  } }, roomId, { generation: 1 });
  const entries: ChannelEntriesView['entries'] = ['cipher-1', 'cipher-2', 'cipher-3'].map(eventId => ({
    kind: 'unavailable', eventId: eventId as EventId, authorParticipantId: 'opaque' as ParticipantId,
    reason: 'missing_key', receivedAt: '2026-09-17T00:00:00Z',
  }));
  emit({ roomId, room, entries, generation: 1, snapshotRevision: 'initial' });
  expect(controller.getSnapshot().rows?.map(row => row.kind)).toEqual(['unavailable', 'unavailable', 'unavailable']);
  expect(controller.getSnapshot().items).toHaveLength(0);
  emit({ roomId, room, entries: [entries[0]!, { kind: 'message', item: item('cipher-2', 'alice', 'readable') }, entries[2]!],
    generation: 1, snapshotRevision: 'late' });
  expect(controller.getSnapshot().rows?.map(row => row.kind)).toEqual(['unavailable', 'message', 'unavailable']);
  expect(controller.getSnapshot().rows?.map(row => row.kind === 'message' ? row.item.ref.eventId : row.eventId))
    .toEqual(['cipher-1', 'cipher-2', 'cipher-3']);
  expect(controller.getSnapshot().items).toHaveLength(1);
  controller.dispose();
});


it('does not count historical ciphertext published after the history promise resolves', async () => {
  const fake = fakeChannelPort();
  let emit!: (view: ChannelEntriesView) => void;
  const controller = createTimelineController({ ...fake.port, observeEntries: (_roomId, listener) => {
    emit = listener; return () => {};
  } }, roomId, { generation: 1 });
  const current = { kind: 'message' as const, item: item('current', 'alice', 'current', '2026-09-17T00:00:00Z') };
  const publish = (entries: ChannelEntriesView['entries'], historicalEventIds: readonly EventId[] = []) => emit({ roomId, room, entries, historicalEventIds, generation: 1, snapshotRevision: 'delayed' });
  publish([current]);
  controller.setReaderAtLatest(false);
  await controller.loadOlder();
  await Promise.resolve();
  const historical = { kind: 'unavailable' as const, eventId: 'historical' as EventId,
    authorParticipantId: 'opaque' as ParticipantId, reason: 'missing_key' as const, receivedAt: '2026-09-16T00:00:00Z' };
  publish([current, historical], [historical.eventId]);
  expect(controller.getSnapshot().rows).toHaveLength(2);
  expect(controller.getSnapshot().newMessageCount).toBe(0);
  const tied = { kind: 'message' as const, item: item('new', 'alice', 'live', current.item.receivedAt) };
  publish([current, historical, tied], [historical.eventId]);
  expect(controller.getSnapshot().newMessageCount).toBe(1);
  publish([current, historical, tied, { kind: 'message', item: item('backwards', 'alice', 'live backwards', '2026-09-15T00:00:00Z') }], [historical.eventId]);
  expect(controller.getSnapshot().newMessageCount).toBe(2);
  controller.dispose();
});

it('does not count channel events as messages and clears recovered name placeholders', async () => {
  const fake = fakeChannelPort();
  let emit!: (view: ChannelEntriesView) => void;
  const controller = createTimelineController({ ...fake.port, observeEntries: (_roomId, listener) => {
    emit = listener; return () => {};
  } }, roomId, { generation: 1 });
  const event = { kind: 'channel_event' as const, eventId: '$event' as EventId, participant: participant('alice', 'Alice'),
    content: { v: 1 as const, body: 'deployed', kind: 'deploy.finished', summary: 'deployed' }, receivedAt: '2026-10-01T10:09:30Z' };
  const missing = { kind: 'unavailable' as const, eventId: event.eventId, authorParticipantId: event.participant.participantId,
    reason: 'missing_key' as const, receivedAt: event.receivedAt };
  emit({ roomId, room, entries: [missing], generation: 1, snapshotRevision: '1' });
  await controller.loadOlder();
  await controller.scanNameHistory?.();
  expect(controller.getSnapshot().namesReady).toBe(false);
  controller.setReaderAtLatest(false);
  emit({ roomId, room, entries: [missing, event, missing, { ...event, eventId: '$new' as EventId }], generation: 1, snapshotRevision: '2' });
  expect(controller.getSnapshot().rows?.map(row => row.kind)).toEqual(['channel_event', 'channel_event']);
  expect(controller.getSnapshot().items).toEqual([]);
  expect(controller.getSnapshot().newMessageCount).toBe(0);
  expect(controller.getSnapshot().namesReady).toBe(true);
  emit({ roomId, room, entries: [event, { kind: 'message', item: item('$message', 'alice', 'hello') }], generation: 1, snapshotRevision: '3' });
  expect(controller.getSnapshot().newMessageCount).toBe(1);
  controller.dispose();
});

it('undoes provisional unread counts when ciphertext becomes an event or is ignored', () => {
  const fake = fakeChannelPort();
  let emit!: (view: ChannelEntriesView) => void;
  const controller = createTimelineController({ ...fake.port, observeEntries: (_roomId, listener) => {
    emit = listener; return () => {};
  } }, roomId, { generation: 1 });
  controller.setReaderAtLatest(false);
  const missing = (id: string) => ({ kind: 'unavailable' as const, eventId: id as EventId,
    authorParticipantId: 'alice' as ParticipantId, reason: 'missing_key' as const, receivedAt: '2026-10-01T10:09:30Z' });
  emit({ roomId, room, entries: [missing('$valid'), missing('$invalid')], generation: 1, snapshotRevision: '1' });
  expect(controller.getSnapshot().newMessageCount).toBe(2);
  const event = { kind: 'channel_event' as const, eventId: '$valid' as EventId, participant: participant('alice', 'Alice'),
    content: { v: 1 as const, body: 'deployed', kind: 'deploy.finished', summary: 'deployed' }, receivedAt: '2026-10-01T10:09:30Z' };
  emit({ roomId, room, entries: [event], ignoredEventIds: ['$invalid' as EventId], generation: 1, snapshotRevision: '2' });
  expect(controller.getSnapshot().newMessageCount).toBe(0);
  emit({ roomId, room, entries: [event], ignoredEventIds: ['$invalid' as EventId], generation: 1, snapshotRevision: '3' });
  expect(controller.getSnapshot().newMessageCount).toBe(0);
  controller.dispose();
});
