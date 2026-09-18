// A synthetic in-memory ReviewUiPort for the browser harness only. Not a
// production adapter; no real network, storage, owner authority, or crypto —
// event refs carry placeholder digests the harness never verifies.

import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import type { BindingId, ReceiptId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { DeliveryReceipt } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/ids';
import type { OwnerId, ParticipantId, TimelineItem } from '@khala/contracts/messaging/index';
import type { ApprovalUiResult, ReviewUiPort } from '../ports';
import type { ReviewView } from '../model';

const bindingId = 'bind_harness' as BindingId;
const roomId = 'room_harness' as RoomId;
const viewerOwnerId = 'owner_alice' as OwnerId;
const alice = { participantId: 'alice' as ParticipantId, kind: 'human' as const, ownerId: viewerOwnerId, displayName: 'Alice', deviceIds: [] };
const bob = { participantId: 'bob' as ParticipantId, kind: 'human' as const, ownerId: 'owner_bob' as OwnerId, displayName: 'Bob', deviceIds: [] };

/** Synthetic, non-cryptographic digest that actually varies with `body` — real enough for this harness to exercise AE1 (an edited body must change the digest and invalidate a captured selection). */
function digestFor(body: string): string {
  let hash = 0;
  for (let index = 0; index < body.length; index += 1) hash = (Math.imul(hash, 31) + body.charCodeAt(index)) >>> 0;
  return `sha256:${hash.toString(16).padStart(8, '0').repeat(8)}`;
}

function makeItem(eventId: string, author: typeof alice, body: string): Extract<TimelineItem, { content: { kind: 'text' } }> {
  return {
    ref: {
      v: 1,
      roomId,
      eventId: eventId as never,
      authorParticipantId: author.participantId,
      authorDeviceId: `device_${author.participantId}` as never,
      contentDigest: digestFor(body),
    },
    content: { v: 1, kind: 'text', body },
    participant: author,
    clientTxnId: null,
    receivedAt: '2026-09-18T00:00:00Z',
  };
}

export function createFakeReviewPort() {
  let access: ReviewView['access'] = 'ready';
  let bindingGeneration = 0;
  const policyVersion = 3;
  let pending: TimelineItem[] = [
    makeItem('pending_1', alice, 'Please forward the deployment summary to the release channel.'),
    makeItem('pending_2', bob, 'Approve the fix for the review queue bug.'),
  ];
  let receipts: DeliveryReceipt[] = [];
  const listeners = new Set<() => void>();
  let releaseCounter = 0;
  let lastCommand: ApprovalCommand | null = null;

  function currentView(): ReviewView {
    return { access, bindingId, bindingGeneration, policyVersion, viewerOwnerId, pending, receipts };
  }

  function notify(): void {
    listeners.forEach(listener => listener());
  }

  const port: ReviewUiPort = {
    snapshot: currentView,
    subscribe: (listener, signal) => {
      listeners.add(listener);
      const remove = () => listeners.delete(listener);
      signal.addEventListener('abort', remove, { once: true });
      return remove;
    },
    approve: async (command: ApprovalCommand): Promise<ApprovalUiResult> => {
      lastCommand = command;
      if (access !== 'ready') return { kind: 'rejected', code: 'forbidden' };
      if (command.expectedBindingGeneration !== bindingGeneration) return { kind: 'rejected', code: 'stale_binding' };
      if (command.selection.some(ref => ref.roomId === roomId && ref.eventId === ('outcome_unknown_target' as never))) {
        return { kind: 'outcome_unknown', commandId: command.commandId };
      }
      releaseCounter += 1;
      const releaseId = `release_${releaseCounter}` as ReleaseId;
      pending = pending.filter(item => !command.selection.some(ref => ref.eventId === item.ref.eventId));
      const receipt: DeliveryReceipt = {
        v: 1,
        receiptId: `receipt_${releaseCounter}` as ReceiptId,
        releaseId,
        bindingId,
        generation: bindingGeneration,
        kind: 'transport_written',
        observedAt: '2026-09-18T00:01:00Z',
        source: 'connector',
        evidenceRef: null,
        errorCode: null,
      };
      receipts = [...receipts, receipt];
      notify();
      return { kind: 'accepted', releaseIds: [releaseId] };
    },
  };

  return {
    port,
    pushLiveArrival(body: string) {
      pending = [...pending, makeItem(`live_${pending.length}`, bob, body)];
      notify();
    },
    editPending(eventId: string, body: string) {
      pending = pending.map(item => (item.ref.eventId === eventId ? makeItem(eventId, alice, body) : item));
      notify();
    },
    bumpBindingGeneration() {
      bindingGeneration += 1;
      notify();
    },
    revoke() {
      access = 'revoked';
      notify();
    },
    /** The last `ApprovalCommand` actually sent to `approve`, for asserting the exact wire selection (KTD1). */
    getLastCommand(): ApprovalCommand | null {
      return lastCommand;
    },
  };
}
