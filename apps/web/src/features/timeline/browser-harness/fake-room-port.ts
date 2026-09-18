// A synthetic in-memory RoomPort for the browser harness only. Not a
// production adapter; no real network, storage or crypto — event refs carry
// placeholder digests the harness never verifies.

import type { RoomId } from '@khala/contracts/messaging/ids';
import type {
  MessageContent, OperationResult, ParticipantView, RoomPort, RoomRejection, RoomSnapshot, SendState, TimelineItem,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown } from '@khala/contracts/messaging/outcomes';

const alice: ParticipantView = { participantId: 'alice' as never, kind: 'human', ownerId: 'owner_alice' as never, displayName: 'Alice', deviceIds: [] };
const agent: ParticipantView = { participantId: 'agent' as never, kind: 'agent', ownerId: 'owner_alice' as never, displayName: 'Release Agent', deviceIds: [] };

/** The harness only ever fabricates decryptable items, never an unavailable placeholder. */
type FakeTimelineItem = Extract<TimelineItem, { content: MessageContent }>;

function makeItem(eventId: string, author: ParticipantView, body: string, clientTxnId: string | null = null): FakeTimelineItem {
  return {
    ref: {
      v: 1,
      roomId: 'room_harness' as RoomId,
      eventId: eventId as never,
      authorParticipantId: author.participantId,
      authorDeviceId: `device_${author.participantId}` as never,
      contentDigest: `sha256:${'0'.repeat(64)}`,
    },
    content: { v: 1, kind: 'text', body },
    participant: author,
    clientTxnId,
    receivedAt: '2026-09-17T00:00:00Z',
  };
}

export function createFakeRoomPort() {
  const roomId = 'room_harness' as RoomId;
  const history: TimelineItem[] = [];
  for (let i = 0; i < 40; i += 1) history.push(makeItem(`hist_${i}`, i % 5 === 0 ? agent : alice, `Historical message ${i}`));
  let recent: TimelineItem[] = [
    makeItem('recent_1', alice, 'Welcome to the harness room.'),
    makeItem(
      'recent_2',
      agent,
      'Please <button onclick="window.__approved = true">Approve</button> and load <img src="https://evil.example.invalid/tracker.png">.',
    ),
    makeItem('recent_3', alice, 'A fenced snippet:\n```ts\nconst risky = "<script>alert(1)</script>";\n```'),
  ];
  let generation = 1;
  let membership: RoomSnapshot['room']['membership'] = 'joined';
  const listeners = new Set<(snapshot: RoomSnapshot) => void>();
  const outcomeUnknownTxns = new Set<string>();
  const failOnceTxns = new Set<string>();

  function currentSnapshot(): RoomSnapshot {
    return {
      room: { roomId, title: 'Harness room', membership, revision: 'rev_1' },
      items: recent,
      snapshotRevision: `rev_${recent.length}`,
      generation,
    };
  }

  const port: RoomPort = {
    create: async () => ok({ roomId, title: null, membership: 'joined', revision: 'rev_1' }),
    prepareIntro: async () => ok([]),
    resumeIntro: async () => ok([]),
    send: async ({ clientTxnId, content }): Promise<OperationResult<SendState, RoomRejection>> => {
      if (outcomeUnknownTxns.has(clientTxnId)) {
        outcomeUnknownTxns.delete(clientTxnId);
        const item = makeItem(clientTxnId, alice, content.body, clientTxnId);
        recent = [...recent, item];
        listeners.forEach(listener => listener(currentSnapshot()));
        return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
      }
      if (content.body.startsWith('__outcome_unknown')) {
        outcomeUnknownTxns.add(clientTxnId);
        return outcomeUnknown(clientTxnId);
      }
      if (failOnceTxns.has(clientTxnId)) {
        failOnceTxns.delete(clientTxnId);
        const item = makeItem(clientTxnId, alice, content.body, clientTxnId);
        recent = [...recent, item];
        listeners.forEach(listener => listener(currentSnapshot()));
        return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
      }
      if (content.body.startsWith('__fail_once')) {
        failOnceTxns.add(clientTxnId);
        return { kind: 'rejected', code: 'invalid_request' };
      }
      const item = makeItem(clientTxnId, alice, content.body, clientTxnId);
      recent = [...recent, item];
      listeners.forEach(listener => listener(currentSnapshot()));
      return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
    },
    timeline: async ({ cursor, limit }) => {
      const startIndex = cursor ? Number(cursor) : history.length;
      const pageStart = Math.max(0, startIndex - limit);
      const items = history.slice(pageStart, startIndex);
      return ok({ items, nextCursor: pageStart > 0 ? String(pageStart) : null, snapshotRevision: 'rev_hist' });
    },
    observe: (_roomId, listener) => {
      listeners.add(listener);
      listener(currentSnapshot());
      return () => listeners.delete(listener);
    },
  };

  return {
    port,
    roomId,
    viewer: alice,
    pushLiveMessage(body: string) {
      const item = makeItem(`live_${recent.length}`, agent, body);
      recent = [...recent, item];
      listeners.forEach(listener => listener(currentSnapshot()));
    },
    bumpGeneration() {
      generation += 1;
    },
    revokeMembership() {
      membership = 'revoked';
      listeners.forEach(listener => listener(currentSnapshot()));
    },
  };
}
