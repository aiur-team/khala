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
  preview(request: ReviewPreviewRequest, signal: AbortSignal): Promise<
    | Readonly<{ kind: 'ok'; body: unknown }>
    | Readonly<{ kind: 'refused'; code: 'forbidden' | 'revoked' | 'unavailable' }>
    | Readonly<{ kind: 'lost' }>
  >;
  /** Deliberately takes no signal: closing a browser wait is not cancellation. */
  approve(command: ApprovalCommand): Promise<Readonly<{ kind: 'answered'; body: unknown }> | Readonly<{ kind: 'lost' }>>;
}

export type BrowserReviewPortOptions = Readonly<{
  client: ReviewControlClient;
  room: RoomPort;
  roomId: RoomId;
  bindingId: BindingId;
  viewerOwnerId: OwnerId;
  limits: DeliveryLimits;
  /** Receipt refresh interval while observed. Defaults to 5 s; 0 disables polling. */
  refreshMs?: number;
}>;

export type BrowserReviewPort = ReviewUiPort & Readonly<{ dispose(): void }>;

export function createBrowserReviewPort(options: BrowserReviewPortOptions): BrowserReviewPort {
  const { client, room, roomId, bindingId, viewerOwnerId, limits } = options;
  const listeners = new Set<() => void>();
  const releaseIds: ReleaseId[] = [];
  let view: ReviewView = loadingView(bindingId, viewerOwnerId);
  let items: readonly TimelineItem[] = [];
  let roomGeneration: number | null = null;
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
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const answer = await client.preview(
      { bindingId, candidates: candidateRefs(items, limits.maxSelectionEvents), releaseIds: [...releaseIds] },
      controller.signal,
    ).catch(() => ({ kind: 'lost' as const }));
    if (disposed || token !== request || generation !== roomGeneration) return;
    inFlight = null;
    if (answer.kind === 'ok') {
      const preview = decodeReviewPreview(answer.body, limits, bindingId);
      publish(preview === null ? withoutAccess(view, 'unavailable') : readyView(preview, items, viewerOwnerId));
      return;
    }
    publish(withoutAccess(view, answer.kind === 'refused' && answer.code === 'revoked' ? 'revoked' : 'unavailable'));
  }

  function onRoom(snapshot: ChannelSnapshot): void {
    if (disposed || snapshot.room.roomId !== roomId) return;
    if (roomGeneration !== null && snapshot.generation < roomGeneration) return;
    if (snapshot.generation !== roomGeneration) {
      // A reconnect replaces the whole queue; nothing from the old generation survives.
      roomGeneration = snapshot.generation;
      publish({ ...loadingView(bindingId, viewerOwnerId), receipts: view.receipts });
    }
    items = snapshot.items;
    void refresh();
  }

  const stopRoom = room.observe(roomId, onRoom);
  const refreshMs = options.refreshMs ?? 5_000;
  const timer = refreshMs > 0 ? setInterval(() => {
    if (listeners.size > 0) void refresh();
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
        .then(answer => answer.kind === 'answered'
          ? toUiResult(command, answer.body)
          : { kind: 'outcome_unknown', commandId: command.commandId } as const)
        .catch(() => ({ kind: 'outcome_unknown', commandId: command.commandId } as const));
      // Settled answers refresh receipts and the queue even if the caller stopped waiting.
      void sent.then(() => refresh());
      if (signal.aborted) return { kind: 'outcome_unknown', commandId: command.commandId };
      const abandoned = new Promise<ApprovalUiResult>(resolve => {
        signal.addEventListener('abort', () => resolve({ kind: 'outcome_unknown', commandId: command.commandId }), {
          once: true,
        });
      });
      return Promise.race([sent, abandoned]);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight?.abort();
      if (timer !== null) clearInterval(timer);
      stopRoom();
      listeners.clear();
    },
  };
}
