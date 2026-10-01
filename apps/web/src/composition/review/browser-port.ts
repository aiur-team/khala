// Live `ReviewUiPort` for one room and one of the human's agent bindings. It reads
// the human's own room items through the route's `RoomPort`, asks the connector's
// protected review endpoint which exact references are pending, and submits exact
// approval commands. Owner authority never appears here: the injected client is
// the authenticated transport, and the connector derives authority from its
// session, never from a request body.

import {
  type ApprovalCommand, type BindingId, type DeliveryLimits, type EventRef, type ReleaseId,
  decodeApprovalResult,
} from '@khala/contracts/delivery/index';
import type { ChannelSnapshot, OwnerId, RoomId, RoomPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { ReviewView } from '../../features/review/model';
import type { ApprovalUiResult, ReviewUiPort } from '../../features/review/ports';
import { candidateRefs, decodeReviewPreview, loadingView, readyView, withoutAccess } from './snapshot';
import { reviewTrace, reviewTraceId } from './diagnostics';

export type ReviewPreviewRequest = Readonly<{
  bindingId: BindingId;
  candidates: readonly EventRef[];
  releaseIds: readonly ReleaseId[];
}>;

/**
 * The protected human review transport. `lost` means the request may have
 * reached the endpoint and its answer is unknown; it is never a definite refusal.
 */
export interface ReviewControlClient {
  recoverUnknown?(bindingId: BindingId, roomId: RoomId, generation?: number): ApprovalCommand | null;
  preview(request: ReviewPreviewRequest, signal: AbortSignal): Promise<
    | Readonly<{ kind: 'ok'; body: unknown }>
    | Readonly<{ kind: 'waiting_for_agent'; generation: number; body: unknown }>
    | Readonly<{ kind: 'refused'; code: 'forbidden' | 'revoked' | 'unavailable' }>
    | Readonly<{ kind: 'lost' }>
  >;
  /** Deliberately takes no signal: closing a browser wait is not cancellation. */
  approve(command: ApprovalCommand): Promise<Readonly<{ kind: 'answered'; body: unknown }>
    | Readonly<{ kind: 'waiting_for_agent' }> | Readonly<{ kind: 'lost' }>>;
  reconcile(command: ApprovalCommand): Promise<Readonly<{ kind: 'answered'; body: unknown }>
    | Readonly<{ kind: 'waiting_for_agent' }> | Readonly<{ kind: 'lost' }>>;
}

export type BrowserReviewPortOptions = Readonly<{
  client: ReviewControlClient;
  room: RoomPort;
  roomId: RoomId;
  bindingId: BindingId;
  bindingGeneration?: number;
  viewerOwnerId: OwnerId;
  limits: DeliveryLimits;
  /** Receipt refresh interval while observed. Defaults to 5 s; 0 disables polling. */
  refreshMs?: number;
}>;

export type BrowserReviewPort = ReviewUiPort & Readonly<{ dispose(): void }>;

export function createBrowserReviewPort(options: BrowserReviewPortOptions): BrowserReviewPort {
  const { client, room, roomId, bindingId, viewerOwnerId, limits } = options;
  const traceId = reviewTraceId();
  reviewTrace('port.mount', traceId, JSON.stringify([roomId, bindingId, options.bindingGeneration, viewerOwnerId]));
  const listeners = new Set<() => void>();
  const releaseIds: ReleaseId[] = [];
  let view: ReviewView = loadingView(bindingId, viewerOwnerId);
  let items: readonly TimelineItem[] = [];
  let roomGeneration: number | null = null;
  let roomMembership: ChannelSnapshot['room']['membership'] | null = null;
  let roomIdentity: string | null = null;
  let request = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  function publish(next: ReviewView): void {
    if (disposed) return;
    view = next;
    for (const listener of [...listeners]) listener();
  }

  async function refresh(): Promise<void> {
    if (disposed || roomGeneration === null) return;
    // Every answer is a complete snapshot; only the newest request may publish one.
    const token = ++request;
    const generation = roomGeneration;
    if (inFlight) reviewTrace('preview.abort-previous', traceId);
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    reviewTrace('preview.start', traceId);
    const answer = await client.preview(
      { bindingId, candidates: candidateRefs(items, limits.maxSelectionEvents), releaseIds: [...releaseIds] },
      controller.signal,
    ).catch(() => ({ kind: 'lost' as const }));
    if (disposed || token !== request || generation !== roomGeneration) {
      reviewTrace('preview.fenced', traceId);
      return;
    }
    reviewTrace(`preview.${answer.kind}`, traceId);
    inFlight = null;
    if (answer.kind === 'ok' || answer.kind === 'waiting_for_agent') {
      if (answer.kind === 'waiting_for_agent' && options.bindingGeneration !== undefined
        && answer.generation !== options.bindingGeneration) {
        publish(withoutAccess(view, 'unavailable'));
        return;
      }
      if (answer.kind === 'waiting_for_agent' && answer.body === null) {
        publish({ ...view, access: 'waiting_for_agent', pending: [], pendingKnown: false });
        return;
      }
      const preview = decodeReviewPreview(answer.body, limits, bindingId);
      reviewTrace(preview === null ? 'preview.decode-failed' : 'preview.decoded', traceId);
      const ready = preview !== null && (options.bindingGeneration === undefined
        || preview.bindingGeneration === options.bindingGeneration)
        && (answer.kind !== 'waiting_for_agent' || preview.bindingGeneration === answer.generation);
      reviewTrace(ready ? 'view.ready-publish' : 'view.unavailable-publish', traceId);
      publish(preview === null || (options.bindingGeneration !== undefined
        && preview.bindingGeneration !== options.bindingGeneration)
        || answer.kind === 'waiting_for_agent' && preview.bindingGeneration !== answer.generation
        ? withoutAccess(view, 'unavailable') : {
        ...readyView(preview, items, viewerOwnerId),
        access: answer.kind === 'ok' ? 'ready' : 'waiting_for_agent',
      });
      return;
    }
    publish(withoutAccess(view, answer.kind === 'refused' && answer.code === 'revoked' ? 'revoked' : 'unavailable'));
  }

  function onRoom(snapshot: ChannelSnapshot): void {
    if (disposed || snapshot.room.roomId !== roomId) return;
    if (roomGeneration !== null && snapshot.generation < roomGeneration) {
      reviewTrace('room.old-generation', traceId);
      return;
    }
    // Snapshot revisions can advance without changing any review input. Repeated
    // equivalent snapshots must not abort the only live owner preview request.
    const identity = JSON.stringify([snapshot.generation, snapshot.room.membership,
      candidateRefs(snapshot.items, limits.maxSelectionEvents)]);
    items = snapshot.items;
    if (identity === roomIdentity) {
      reviewTrace('room.equivalent', traceId);
      return;
    }
    reviewTrace('room.changed', traceId, identity);
    roomIdentity = identity;
    if (snapshot.generation !== roomGeneration || snapshot.room.membership !== roomMembership) {
      // A reconnect or trust change replaces the queue while the new preview loads.
      roomGeneration = snapshot.generation;
      roomMembership = snapshot.room.membership;
      publish({ ...loadingView(bindingId, viewerOwnerId), receipts: view.receipts });
    }
    void refresh();
  }

  const stopRoom = room.observe(roomId, onRoom);
  reviewTrace('room.observe', traceId);
  const refreshMs = options.refreshMs ?? 5_000;
  const timer = refreshMs > 0 ? setInterval(() => {
    // A slow answer is never cancelled by the next tick; only new room data supersedes it.
    if (listeners.size > 0 && inFlight === null) void refresh();
  }, refreshMs) : null;
  (timer as { unref?: () => void } | null)?.unref?.();

  function toUiResult(command: ApprovalCommand, body: unknown): ApprovalUiResult {
    const decoded = decodeApprovalResult(body, limits);
    // A malformed answer may still follow a write: it is unknown, never success.
    if (!decoded.ok) return { kind: 'outcome_unknown', commandId: command.commandId };
    const result = decoded.value;
    if (result.ok) {
      for (const id of result.releaseIds) if (!releaseIds.includes(id)) releaseIds.push(id);
      return { kind: 'accepted', releaseIds: result.releaseIds };
    }
    if (result.code === 'outcome_unknown') return { kind: 'outcome_unknown', commandId: command.commandId };
    return { kind: 'rejected', code: result.code };
  }

  return {
    recoverUnknown: () => client.recoverUnknown?.(bindingId, roomId, options.bindingGeneration) ?? null,
    snapshot: () => view,

    subscribe(listener, signal) {
      if (disposed || signal.aborted) return () => undefined;
      listeners.add(listener);
      const release = () => { listeners.delete(listener); };
      signal.addEventListener('abort', release, { once: true });
      return () => {
        signal.removeEventListener('abort', release);
        release();
      };
    },

    async approve(command, signal) {
      if (disposed) return { kind: 'outcome_unknown', commandId: command.commandId };
      const sent = client.approve(command)
        .then(answer => answer.kind === 'answered' ? toUiResult(command, answer.body)
          : answer.kind === 'waiting_for_agent' ? { kind: 'waiting_for_agent', commandId: command.commandId } as const
            : { kind: 'outcome_unknown', commandId: command.commandId } as const)
        .catch(() => ({ kind: 'outcome_unknown', commandId: command.commandId } as const));
      // Settled answers refresh receipts and the queue even if the caller stopped waiting.
      void sent.then(() => refresh());
      if (signal.aborted) return { kind: 'outcome_unknown', commandId: command.commandId };
      let stopWaiting: () => void = () => {};
      const abandoned = new Promise<ApprovalUiResult>(resolve => {
        const onAbort = () => resolve({ kind: 'outcome_unknown', commandId: command.commandId });
        signal.addEventListener('abort', onAbort, { once: true });
        stopWaiting = () => signal.removeEventListener('abort', onAbort);
      });
      try {
        return await Promise.race([sent, abandoned]);
      } finally {
        stopWaiting();
      }
    },

    async reconcile(command, signal) {
      if (disposed || signal.aborted) return { kind: 'outcome_unknown', commandId: command.commandId };
      const answer = await client.reconcile(command).catch(() => ({ kind: 'lost' as const }));
      if (disposed || signal.aborted) return { kind: 'outcome_unknown', commandId: command.commandId };
      const outcome: ApprovalUiResult = answer.kind === 'answered' ? toUiResult(command, answer.body)
        : answer.kind === 'waiting_for_agent' ? { kind: 'waiting_for_agent', commandId: command.commandId }
          : { kind: 'outcome_unknown', commandId: command.commandId };
      return outcome;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      reviewTrace('port.dispose', traceId);
      inFlight?.abort();
      if (timer !== null) clearInterval(timer);
      stopRoom();
      listeners.clear();
    },
  };
}
