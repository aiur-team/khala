// A synthetic in-memory ChannelPort for the browser harness only. Not a
// production adapter; no real network, storage or crypto — event refs carry
// placeholder digests the harness never verifies.

import type { RoomId } from '@khala/contracts/messaging/ids';
import type {
  MessageContent, OperationResult, ParticipantView, ChannelPort, ChannelRejection, ChannelSnapshot, SendState, TimelineItem,
} from '@khala/contracts/messaging/index';
import type { TimelineEntriesView, TimelineRow } from '../controller';
import { ok, outcomeUnknown } from '@khala/contracts/messaging/outcomes';

const alice: ParticipantView = { participantId: 'alice' as never, kind: 'human', ownerId: 'owner_alice' as never, displayName: 'Alice', deviceIds: [] };
const agent: ParticipantView = { participantId: 'agent' as never, kind: 'agent', ownerId: 'owner_alice' as never, displayName: 'Release Agent', deviceIds: [] };

/** The harness only ever fabricates decryptable items, never an unavailable placeholder. */
type FakeTimelineItem = Extract<TimelineItem, { content: MessageContent }>;

let eventSequence = 0;

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
    receivedAt: new Date(Date.parse('2026-09-17T00:00:00Z') + eventSequence++).toISOString(),
  };
}

export function createFakeChannelPort(empty = false) {
  const roomId = 'room_harness' as RoomId;
  const history: TimelineItem[] = [];
  for (let i = 0; i < 40; i += 1) history.push(makeItem(`hist_${i}`, i % 5 === 0 ? agent : alice, `Historical message ${i}`));
  let recent: TimelineItem[] = [
    makeItem('recent_1', alice, 'Welcome to the harness channel.'),
    makeItem(
      'recent_2',
      agent,
      'Please <button onclick="window.__approved = true">Approve</button> and load <img src="https://evil.example.invalid/tracker.png">.',
    ),
    makeItem('recent_3', alice, 'A fenced snippet:\n```ts\nconst risky = "<script>alert(1)</script>";\n```'),
  ];
  if (empty) { history.length = 0; recent = []; }
  let historyCalls = 0;
  let releaseHistory: (() => void) | undefined;
  let delayHistory = false;
  let generation = 1;
  let membership: ChannelSnapshot['room']['membership'] = 'joined';
  const listeners = new Set<(snapshot: ChannelSnapshot) => void>();
  const entryListeners = new Set<(view: TimelineEntriesView) => void>();
  let encrypted: TimelineRow | null = null;
  function entriesView(): TimelineEntriesView {
    const snapshot = currentSnapshot();
    const entries: TimelineRow[] = recent.map(item => ({ kind: 'message', item }));
    if (encrypted) entries.splice(1, 0, encrypted);
    return { ...snapshot, roomId, entries };
  }
  function emit() {
    listeners.forEach(listener => listener(currentSnapshot()));
    entryListeners.forEach(listener => listener(entriesView()));
  }
  const outcomeUnknownTxns = new Set<string>();
  const failOnceTxns = new Set<string>();
  const deferredSync: TimelineItem[] = [];
  let delayNext = false;
  let releaseDelayed: (() => void) | undefined;

  function currentSnapshot(): ChannelSnapshot {
    return {
      room: { roomId, title: 'Harness channel', membership, revision: 'rev_1' },
      items: recent,
      snapshotRevision: `rev_${recent.length}`,
      generation,
    };
  }

  const port: ChannelPort & { observeEntries(roomId: RoomId, listener: (view: TimelineEntriesView) => void): () => void } = {
    observeEntries: (_roomId, listener) => {
      entryListeners.add(listener); listener(entriesView());
      return () => entryListeners.delete(listener);
    },
    create: async () => ok({ roomId, title: null, membership: 'joined', revision: 'rev_1' }),
    prepareIntro: async () => ok([]),
    resumeIntro: async () => ok([]),
    send: async ({ clientTxnId, content }): Promise<OperationResult<SendState, ChannelRejection>> => {
      if (delayNext) {
        delayNext = false;
        await new Promise<void>(resolve => { releaseDelayed = resolve; });
      }
      if (outcomeUnknownTxns.has(clientTxnId)) {
        outcomeUnknownTxns.delete(clientTxnId);
        const item = makeItem(clientTxnId, alice, content.body);
        recent = [...recent, item];
        emit();
        return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
      }
      if (content.body.startsWith('__outcome_unknown')) {
        outcomeUnknownTxns.add(clientTxnId);
        return outcomeUnknown(clientTxnId);
      }
      if (failOnceTxns.has(clientTxnId)) {
        failOnceTxns.delete(clientTxnId);
        const item = makeItem(clientTxnId, alice, content.body);
        recent = [...recent, item];
        emit();
        return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
      }
      if (content.body.startsWith('__fail_once')) {
        failOnceTxns.add(clientTxnId);
        return { kind: 'rejected', code: 'invalid_request' };
      }
      // A Matrix sync from the server can omit unsigned.transaction_id even
      // though the send acknowledgment named the exact event.
      const item = makeItem(clientTxnId, alice, content.body);
      if (content.body.startsWith('__defer_sync')) {
        deferredSync.push(item);
        return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
      }
      recent = [...recent, item];
      emit();
      return ok({ clientTxnId, state: 'accepted', eventRef: item.ref });
    },
    timeline: async ({ cursor, limit }) => {
      historyCalls += 1;
      if (delayHistory) {
        delayHistory = false;
        await new Promise<void>(resolve => { releaseHistory = resolve; });
      }
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
    historyCalls: () => historyCalls,
    delayHistory: () => { delayHistory = true; },
    releaseHistory: () => { releaseHistory?.(); },
    showUnavailable() {
      encrypted = { kind: 'unavailable', eventId: 'encrypted' as never, receivedAt: '2026-09-17T00:00:00Z' };
      emit();
    },
    decryptUnavailable() {
      encrypted = { kind: 'message', item: makeItem('encrypted', alice, 'Recovered message') };
      emit();
    },
    roomId,
    viewer: alice,
    delayNextSend() { delayNext = true; },
    releaseDelayedSend() {
      releaseDelayed?.();
      releaseDelayed = undefined;
    },
    releaseNextSend() {
      const item = deferredSync.shift();
      if (!item) return;
      recent = [...recent, item];
      emit();
    },
    pushLiveMessage(body: string) {
      const item = makeItem(`live_${recent.length}`, agent, body);
      recent = [...recent, item];
      emit();
    },
    bumpGeneration() {
      generation += 1;
    },
    revokeMembership() {
      membership = 'revoked';
      emit();
    },
  };
}
