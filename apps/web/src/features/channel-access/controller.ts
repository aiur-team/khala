import {
  decodeChannelAccessNotification,
  decodeChannelAccessOwnerProjection,
  type ChannelAccessRequestHandle,
  type Disposer,
  type OperationResult,
} from '@khala/contracts/messaging/index';
import { isDecidable, type DecisionChoice, type DecisionStatus } from '../approval-decision/model';
import {
  INITIAL_INBOX_VIEW,
  isRetained,
  type InboxNotice,
  type InboxView,
  type OwnerRequest,
} from './model';
import type { ChannelAccessPorts, InboxRejection } from './ports';

export interface ChannelAccessInboxController {
  getView(): InboxView;
  subscribe(listener: (view: InboxView) => void): Disposer;
  /** Loads the inbox and starts listening for notifications. Idempotent. */
  start(): void;
  refresh(): void;
  /** Points at one row, from a notification or direct navigation. Never opens a decision. */
  select(handle: string | null): void;
  /** Follows a notification to its row (or the whole list for a batch) and dismisses it. */
  openNotice(notificationId: string): void;
  dismissNotice(notificationId: string): void;
  /** Opens the decision dialog. Only an explicit owner action calls this. */
  open(handle: string): void;
  /** Closes the dialog. The request stays in the inbox, and nothing else opens. */
  close(): void;
  decide(choice: DecisionChoice): void;
  /** Resends the held decision with its original operation ID and the refreshed revision. */
  retry(): void;
  toggleMute(handle: string): void;
  dispose(): void;
}

export type ChannelAccessInboxOptions = Readonly<{
  createId?: () => string;
  now?: () => number;
}>;

const defaultCreateId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

const RETRYABLE_MESSAGE = 'Could not confirm your decision with the server. Retry sends the same decision; it is never recorded twice.';

const REJECTION_MESSAGE: Readonly<Record<string, string>> = {
  decision_conflict: 'This request was already decided in another window.',
  expired: 'This request expired. Nothing was granted.',
  revoked: 'This request was closed because the channel or the agent changed. Nothing was granted.',
  not_found: 'This request is no longer available.',
  operation_mismatch: 'That decision conflicted with an earlier one. Nothing new was recorded.',
  forbidden: 'You can no longer decide this request. Only the channel’s current owner can.',
};

/** Revisions are opaque; numeric ones compare numerically. */
function isNewer(next: string, current: string): boolean {
  if (/^\d+$/.test(next) && /^\d+$/.test(current)) return Number(next) > Number(current);
  return next !== current;
}

function decidedMessage(request: OwnerRequest): string {
  if (request.ownerDecision === 'denied') return 'Denied. Nothing was granted.';
  return request.operationKind === 'access'
    ? 'Approved. The agent joins when its connector picks this up; this page shows when it connects.'
    : 'Approved. The channel is created when the agent’s connector picks this up; this page shows when it connects.';
}

export function createChannelAccessInboxController(
  ports: ChannelAccessPorts,
  options: ChannelAccessInboxOptions = {},
): ChannelAccessInboxController {
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? Date.now;
  let view: InboxView = INITIAL_INBOX_VIEW;
  let started = false;
  let disposed = false;
  let readSequence = 0;
  let latestRead: Promise<void> = Promise.resolve();
  let unsubscribe: Disposer | null = null;
  // One operation ID per held decision, reused only by `retry()`, so a lost
  // response resolves to the same journal decision instead of a second one.
  let heldDecision: Readonly<{ handle: ChannelAccessRequestHandle; decision: DecisionChoice; operationId: string }> | null = null;
  let heldMute: Readonly<{ handle: ChannelAccessRequestHandle; action: 'mute' | 'unmute'; operationId: string }> | null = null;
  const dismissed = new Map<string, string>();
  const listeners = new Set<(view: InboxView) => void>();

  function emit(next: InboxView): void {
    view = next;
    if (disposed) return;
    for (const listener of listeners) listener(view);
  }

  function setDialogStatus(status: DecisionStatus): void {
    if (view.dialog) emit({ ...view, dialog: { ...view.dialog, status } });
  }

  function decode(items: readonly unknown[]): Readonly<{ requests: OwnerRequest[]; rejected: number }> {
    const requests: OwnerRequest[] = [];
    let rejected = 0;
    for (const item of items) {
      const decoded = decodeChannelAccessOwnerProjection(item);
      if (decoded.ok) requests.push(decoded.value);
      else rejected += 1;
    }
    return { requests, rejected };
  }

  function loseAuthority(): void {
    heldDecision = null;
    heldMute = null;
    emit({
      ...view,
      phase: view.phase === 'loading' ? 'load_failed' : view.phase,
      readOnly: true,
      muting: null,
      status: { kind: 'authority_lost' },
      dialog: view.dialog ? { ...view.dialog, status: { kind: 'blocked', message: REJECTION_MESSAGE.forbidden! } } : null,
    });
  }

  /** Reconciles an open dialog with the refreshed row. */
  function reconcileDialog(requests: readonly OwnerRequest[]): InboxView['dialog'] {
    const dialog = view.dialog;
    if (!dialog) return null;
    const row = requests.find(request => request.requestHandle === dialog.handle);
    if (!row) {
      // Sensitive context past its retention limit disappears, open or not.
      return isRetained(dialog.request, now()) ? dialog : null;
    }
    if (row.ownerDecision === 'pending' && row.outcome === 'pending_owner') return { ...dialog, request: row };
    // Decided (here after a lost response, or elsewhere) or closed.
    const held = heldDecision?.handle === dialog.handle ? heldDecision : null;
    const expected = held ? (held.decision === 'approve' ? 'approved' : 'denied') : null;
    if (dialog.status.kind === 'decided') return { ...dialog, request: row };
    heldDecision = held ? null : heldDecision;
    const status: DecisionStatus = expected !== null && row.ownerDecision === expected
      ? { kind: 'decided', message: decidedMessage(row) }
      : {
        kind: 'blocked',
        message: row.outcome === 'expired' || row.outcome === 'revoked'
          ? REJECTION_MESSAGE[row.outcome]!
          : REJECTION_MESSAGE.decision_conflict!,
      };
    return { ...dialog, request: row, status };
  }

  function readInbox(): Promise<void> {
    latestRead = performRead();
    return latestRead;
  }

  /** Resolves once the newest read, including any started meanwhile, has settled. */
  async function settled(): Promise<void> {
    let read: Promise<void>;
    do {
      read = latestRead;
      await read;
    } while (read !== latestRead);
  }

  async function performRead(): Promise<void> {
    const sequence = ++readSequence;
    let result: OperationResult<readonly unknown[], InboxRejection>;
    try {
      result = await ports.requests.inbox();
    } catch {
      result = { kind: 'unavailable', retryable: true };
    }
    if (disposed || sequence !== readSequence) return;
    if (result.kind === 'ok') {
      const { requests, rejected } = decode(result.value);
      const retained = requests.filter(request => isRetained(request, now()));
      const selected = view.selected;
      emit({
        ...view,
        phase: 'ready',
        requests: retained,
        rejectedCount: rejected,
        readOnly: false,
        status: view.status.kind === 'authority_lost' || view.status.kind === 'refresh_failed' ? { kind: 'idle' } : view.status,
        selected,
        dialog: reconcileDialog(retained),
      });
      return;
    }
    if (result.kind === 'rejected') return loseAuthority();
    emit({ ...view, phase: view.phase === 'loading' ? 'load_failed' : view.phase, status: { kind: 'refresh_failed' } });
  }

  function upsertNotice(input: unknown): void {
    const decoded = decodeChannelAccessNotification(input);
    if (!decoded.ok) return;
    const notification = decoded.value;
    const hidden = dismissed.get(notification.notificationId);
    if (hidden !== undefined && !isNewer(notification.revision, hidden)) return;
    const notice: InboxNotice = {
      notificationId: notification.notificationId,
      revision: notification.revision,
      requestHandle: notification.requestHandle,
      count: notification.count,
    };
    // The notification only says "look again"; the inbox read is
    // authoritative. The notice appears once that read settles, so following
    // it always lands on a loaded row.
    void readInbox();
    void settled().then(() => {
      if (disposed) return;
      const hiddenNow = dismissed.get(notice.notificationId);
      if (hiddenNow !== undefined && !isNewer(notice.revision, hiddenNow)) return;
      const current = view.notices.find(item => item.notificationId === notice.notificationId);
      if (current && !isNewer(notice.revision, current.revision)) return;
      emit({ ...view, notices: [...view.notices.filter(item => item.notificationId !== notice.notificationId), notice] });
    });
  }

  function findRequest(handle: string): OwnerRequest | undefined {
    return view.requests.find(request => request.requestHandle === handle);
  }

  async function submitDecision(): Promise<void> {
    const dialog = view.dialog;
    if (!dialog || heldDecision === null || heldDecision.handle !== dialog.handle) return;
    const held = heldDecision;
    setDialogStatus({ kind: 'submitting', decision: held.decision });
    let result: OperationResult<unknown, string>;
    try {
      result = await ports.requests.decide({
        v: 1,
        requestHandle: held.handle,
        expectedRevision: dialog.request.revision,
        decision: held.decision,
        operationId: held.operationId,
      });
    } catch {
      result = { kind: 'unavailable', retryable: true };
    }
    // A refresh already reconciled this decision (for example, it showed the
    // journal recorded it); a late transport result must not reopen it.
    if (disposed || heldDecision !== held) return;
    const stillOpen = view.dialog?.handle === held.handle;
    if (result.kind === 'ok') {
      const decoded = decodeChannelAccessOwnerProjection(result.value);
      if (decoded.ok) {
        heldDecision = null;
        const row = decoded.value;
        emit({
          ...view,
          requests: [...view.requests.filter(request => request.requestHandle !== row.requestHandle), row],
          dialog: stillOpen ? { handle: held.handle, request: row, status: { kind: 'decided', message: decidedMessage(row) } } : view.dialog,
        });
        return;
      }
      // An undecodable success is an unknown outcome: keep the decision held.
      result = { kind: 'outcome_unknown', operationId: held.operationId };
    }
    if (result.kind === 'rejected') {
      heldDecision = null;
      if (result.code === 'forbidden') return loseAuthority();
      if (stillOpen) {
        setDialogStatus(result.code === 'stale_revision'
          ? { kind: 'refreshed', message: 'This request changed while you were reviewing it. It has been reloaded; review it and decide again.' }
          : { kind: 'blocked', message: REJECTION_MESSAGE[result.code] ?? `Nothing was recorded (${result.code}).` });
      }
      void readInbox();
      return;
    }
    // Unavailable or unknown: keep the dialog, its projection, and the held
    // operation; refresh so a retry carries the current revision.
    if (stillOpen) setDialogStatus({ kind: 'retryable', decision: held.decision, message: RETRYABLE_MESSAGE });
    void readInbox();
  }

  async function submitMute(): Promise<void> {
    const held = heldMute;
    if (held === null) return;
    const request = findRequest(held.handle);
    if (!request) {
      heldMute = null;
      return;
    }
    emit({ ...view, muting: held.handle, status: { kind: 'idle' } });
    let result: Awaited<ReturnType<ChannelAccessPorts['requests']['setMute']>>;
    try {
      result = await ports.requests.setMute({
        v: 1,
        requestHandle: held.handle,
        expectedRevision: request.muteRevision,
        action: held.action,
        operationId: held.operationId,
      });
    } catch {
      result = { kind: 'unavailable', retryable: true };
    }
    if (disposed) return;
    if (result.kind === 'ok') {
      heldMute = null;
      const { muted, revision } = result.value;
      // A mute covers every request in its scope; the refresh brings the rest in line.
      const update = (row: OwnerRequest): OwnerRequest => (row.requestHandle === held.handle ? { ...row, muted, muteRevision: revision } : row);
      emit({
        ...view,
        muting: null,
        requests: view.requests.map(update),
        dialog: view.dialog?.handle === held.handle ? { ...view.dialog, request: update(view.dialog.request) } : view.dialog,
        status: { kind: 'muted', muted, operationKind: request.operationKind },
      });
      void readInbox();
      return;
    }
    if (result.kind === 'rejected') {
      heldMute = null;
      if (result.code === 'stale_revision') {
        emit({ ...view, muting: null, status: { kind: 'mute_refreshed' } });
      } else {
        emit({ ...view, muting: null, status: { kind: 'mute_failed', code: result.code } });
      }
      void readInbox();
      return;
    }
    // Held for the next click on the same action, which reuses the operation ID.
    emit({ ...view, muting: null, status: { kind: 'mute_failed', code: 'unavailable' } });
  }

  return {
    getView: () => view,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (disposed || started) return;
      started = true;
      unsubscribe = ports.requests.subscribe(notification => {
        if (!disposed) upsertNotice(notification);
      });
      void readInbox();
    },

    refresh() {
      if (!disposed) void readInbox();
    },

    select(handle) {
      if (disposed) return;
      emit({ ...view, selected: handle as ChannelAccessRequestHandle | null, selectionSequence: view.selectionSequence + 1 });
    },

    openNotice(notificationId) {
      const notice = view.notices.find(item => item.notificationId === notificationId);
      if (disposed || !notice) return;
      dismissed.set(notice.notificationId, notice.revision);
      emit({
        ...view,
        notices: view.notices.filter(item => item.notificationId !== notificationId),
        selected: notice.requestHandle,
        selectionSequence: view.selectionSequence + 1,
      });
    },

    dismissNotice(notificationId) {
      const notice = view.notices.find(item => item.notificationId === notificationId);
      if (disposed || !notice) return;
      dismissed.set(notice.notificationId, notice.revision);
      emit({ ...view, notices: view.notices.filter(item => item.notificationId !== notificationId) });
    },

    open(handle) {
      if (disposed || view.dialog !== null) return;
      const request = findRequest(handle);
      if (!request) return;
      const status: DecisionStatus = view.readOnly
        ? { kind: 'blocked', message: REJECTION_MESSAGE.forbidden! }
        : request.outcome === 'pending_owner'
          ? { kind: 'idle' }
          : { kind: 'decided', message: 'This request is no longer waiting for a decision.' };
      emit({ ...view, dialog: { handle: request.requestHandle, request, status } });
    },

    close() {
      if (disposed || view.dialog === null) return;
      if (heldDecision?.handle === view.dialog.handle && view.dialog.status.kind !== 'submitting') heldDecision = null;
      // Closing never advances to the next queued request.
      emit({ ...view, dialog: null });
    },

    decide(choice) {
      const dialog = view.dialog;
      if (disposed || view.readOnly || !dialog || !isDecidable(dialog.status)) return;
      heldDecision = { handle: dialog.handle, decision: choice, operationId: createId() };
      void submitDecision();
    },

    retry() {
      const dialog = view.dialog;
      if (disposed || !dialog || dialog.status.kind !== 'retryable' || heldDecision?.handle !== dialog.handle) return;
      void submitDecision();
    },

    toggleMute(handle) {
      if (disposed || view.readOnly || view.muting !== null) return;
      const request = findRequest(handle);
      if (!request) return;
      const action = request.muted ? 'unmute' : 'mute';
      if (heldMute?.handle !== request.requestHandle || heldMute.action !== action) {
        heldMute = { handle: request.requestHandle, action, operationId: createId() };
      }
      void submitMute();
    },

    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}
