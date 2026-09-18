import { describe, expect, it } from 'vitest';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { RoomPort, RoomSnapshot, TimelineItem } from '@khala/contracts/messaging/index';
import { ok, rejected, unavailable, type Disposer } from '@khala/contracts/messaging/outcomes';
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
function fakeRoomPort(pages: Record<string, TimelineItem[]> = {}): { port: RoomPort; emit: (snapshot: RoomSnapshot) => void; listenerCount: () => number } {
  const listeners = new Set<(snapshot: RoomSnapshot) => void>();
  const port: Pick<RoomPort, 'observe' | 'timeline'> = {
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
    port: port as RoomPort,
    emit: snapshot => listeners.forEach(listener => listener(snapshot)),
    listenerCount: () => listeners.size,
  };
}

const room = { roomId, title: null, membership: 'joined' as const, revision: 'rev_1' };

describe('createTimelineController', () => {
  it('merges an older page and a later live snapshot by event ID, rendering shared items once', async () => {
    const { port, emit } = fakeRoomPort({ first: [item('E1', 'alice', 'first'), item('E2', 'alice', 'second')] });
    const controller = createTimelineController(port, roomId, { generation: 1 });

    await controller.loadOlder();
    emit({ room, items: [item('E2', 'alice', 'second'), item('E3', 'bob', 'third')], snapshotRevision: 'rev_2', generation: 1 });

    const { items } = controller.getSnapshot();
    expect(items.map(entry => entry.ref.eventId)).toEqual(['E1', 'E2', 'E3']);
    controller.dispose();
  });

  it('keeps two records with identical text from different authenticated authors, each with correct ownership', () => {
    const { port, emit } = fakeRoomPort();
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
    const { port, emit, listenerCount } = fakeRoomPort();
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
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => {
        timelineCalls += 1;
        return ok({ items: [item('E1', 'alice', 'first'), item('E2', 'alice', 'second')], nextCursor: null, snapshotRevision: 'rev_1' });
      },
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });

    const [first, second] = await Promise.all([controller.loadOlder(), controller.loadOlder()]);
    expect(timelineCalls).toBe(1);
    expect(first).toBe(second);
    expect(controller.getSnapshot().items.map(entry => entry.ref.eventId)).toEqual(['E1', 'E2']);
    controller.dispose();
  });

  it('caches the returned snapshot reference until state actually changes', () => {
    const { port } = fakeRoomPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });
    const first = controller.getSnapshot();
    const second = controller.getSnapshot();
    expect(first).toBe(second);
    controller.dispose();
  });

  it('surfaces an unavailable first page as phase "unavailable" without throwing', async () => {
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => unavailable(),
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });
    await controller.loadOlder();
    expect(controller.getSnapshot().phase).toBe('unavailable');
    controller.dispose();
  });

  it('resets newMessageCount only once the reader returns to latest', () => {
    const { port, emit } = fakeRoomPort();
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
    const { port, emit } = fakeRoomPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });

    emit({ room, items: [item('E1', 'alice', 'one')], snapshotRevision: 'rev_1', generation: 1 });
    expect(controller.getSnapshot().newMessageCount).toBe(0);
    controller.dispose();
  });

  it('a forbidden first page with no items loaded leaves the room unavailable, never a false-empty "ready"', async () => {
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => rejected('forbidden'),
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });
    await controller.loadOlder();
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('unavailable');
    expect(snapshot.items).toEqual([]);
    controller.dispose();
  });

  it('a forbidden first page arriving after a live snapshot already showed items reports "partial", not "ready" with the gap hidden', async () => {
    const listeners = new Set<(snapshot: RoomSnapshot) => void>();
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (_roomId, listener): Disposer => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeline: async () => rejected('forbidden'),
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });
    listeners.forEach(listener => listener({ room, items: [item('E1', 'alice', 'live')], snapshotRevision: 'rev_1', generation: 1 }));
    expect(controller.getSnapshot().phase).toBe('ready');

    await controller.loadOlder();
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('partial');
    expect(snapshot.items.map(entry => entry.ref.eventId)).toEqual(['E1']);
    controller.dispose();
  });

  it('a forbidden first page reported before any snapshot arrives stays "unavailable" once an empty snapshot arrives — arrival order does not change the outcome', async () => {
    const listeners = new Set<(snapshot: RoomSnapshot) => void>();
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (_roomId, listener): Disposer => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeline: async () => rejected('forbidden'),
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });
    await controller.loadOlder();
    expect(controller.getSnapshot().phase).toBe('unavailable');

    // A later, otherwise-unremarkable empty snapshot must not overwrite the
    // known history gap with a false-empty "ready".
    listeners.forEach(listener => listener({ room, items: [], snapshotRevision: 'rev_1', generation: 1 }));
    expect(controller.getSnapshot().phase).toBe('unavailable');
    controller.dispose();
  });

  it('"partial" does not revert to "ready" on the next live message; it clears only once a history read succeeds', async () => {
    const listeners = new Set<(snapshot: RoomSnapshot) => void>();
    let timelineResult: 'forbidden' | 'ok' = 'forbidden';
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (_roomId, listener): Disposer => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeline: async () => (timelineResult === 'forbidden' ? rejected('forbidden') : ok({ items: [], nextCursor: null, snapshotRevision: 'rev_2' })),
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });
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
    const { port, emit } = fakeRoomPort();
    const controller = createTimelineController(port, roomId, { generation: 1 });
    expect(controller.getSnapshot().membership).toBeNull();

    emit({ room: { ...room, membership: 'revoked' }, items: [], snapshotRevision: 'rev_1', generation: 1 });
    expect(controller.getSnapshot().membership).toBe('revoked');
    controller.dispose();
  });

  it('deduplicates an older page against rows already known from an earlier page, never rendering a duplicate row', async () => {
    let call = 0;
    const port: Pick<RoomPort, 'observe' | 'timeline'> = {
      observe: (): Disposer => () => {},
      timeline: async () => {
        call += 1;
        // The second page overlaps the first by event E4 (a flaky backend
        // returning an already-seen boundary row), which must not duplicate.
        if (call === 1) return ok({ items: [item('E5', 'alice', 'five'), item('E4', 'alice', 'four')], nextCursor: 'c1', snapshotRevision: 'rev_1' });
        return ok({ items: [item('E4', 'alice', 'four'), item('E3', 'alice', 'three')], nextCursor: null, snapshotRevision: 'rev_2' });
      },
    };
    const controller = createTimelineController(port as RoomPort, roomId, { generation: 1 });
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
