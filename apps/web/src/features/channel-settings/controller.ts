import type { ChannelVisibility, Disposer, OperationResult, RoomId } from '@khala/contracts/messaging/index';
import {
  INITIAL_VIEW,
  isVisibilityIncrease,
  projectListing,
  toAllowlisted,
  type ChannelSettingsStatus,
  type ChannelSettingsView,
  type PendingEdit,
} from './model';
import type { ChannelSettingsPorts, ChannelSettingsSnapshot, MutationApplied } from './ports';

export interface ChannelSettingsController {
  getView(): ChannelSettingsView;
  subscribe(listener: (view: ChannelSettingsView) => void): Disposer;
  /** Reloads settings and the picker; also the recovery path after a failed load. */
  load(): void;
  setVisibility(visibility: ChannelVisibility): void;
  setTitle(title: string): void;
  /** Saves a decrease directly; an increase first asks for confirmation. */
  save(): void;
  confirm(): void;
  /** Dismisses the confirmation. Nothing is sent and the draft returns to the saved settings. */
  cancel(): void;
  /** Allows a principal the picker offered; anything else is ignored. */
  allow(principal: string): void;
  revoke(principal: string): void;
  /** Resubmits a retryable pending edit with the same operation ID. */
  retry(): void;
  dispose(): void;
}

const defaultCreateId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

export function createChannelSettingsController(
  ports: ChannelSettingsPorts,
  roomId: RoomId,
  options: Readonly<{ createId?: () => string }> = {},
): ChannelSettingsController {
  const createId = options.createId ?? defaultCreateId;
  let view: ChannelSettingsView = INITIAL_VIEW;
  let disposed = false;
  let loadSequence = 0;
  // One operation ID per pending edit, reused only by `retry()` so a lost
  // response never becomes a second write.
  let operationId: string | null = null;
  const listeners = new Set<(view: ChannelSettingsView) => void>();

  function emit(next: ChannelSettingsView): void {
    view = next;
    if (disposed) return;
    for (const listener of listeners) listener(view);
  }

  function withDraft(next: ChannelSettingsView, visibility: ChannelVisibility, title: string): ChannelSettingsView {
    return { ...next, draftVisibility: visibility, draftTitle: title, titleError: null, preview: projectListing(visibility, title) };
  }

  /** Resets the draft to the given server state. */
  function fromSnapshot(snapshot: ChannelSettingsSnapshot, status: ChannelSettingsStatus): ChannelSettingsView {
    return withDraft(
      { ...view, phase: 'editing', saved: snapshot, readOnly: !snapshot.canManage, pending: null, status },
      snapshot.visibility,
      snapshot.listedTitle ?? snapshot.channelName,
    );
  }

  function loseAuthority(): void {
    operationId = null;
    const saved = view.saved;
    emit({
      ...(saved ? fromSnapshot({ ...saved, canManage: false }, { kind: 'authority_lost' }) : view),
      phase: saved ? 'editing' : 'load_failed',
      readOnly: true,
      pending: null,
      status: { kind: 'authority_lost' },
    });
  }

  async function readSettings(status: ChannelSettingsStatus): Promise<void> {
    const sequence = ++loadSequence;
    let result: OperationResult<ChannelSettingsSnapshot, 'forbidden'>;
    try {
      result = await ports.settings.read(roomId);
    } catch {
      result = { kind: 'unavailable', retryable: true };
    }
    if (disposed || sequence !== loadSequence) return;
    if (result.kind === 'ok') emit(fromSnapshot(result.value, status));
    else if (result.kind === 'rejected') loseAuthority();
    else emit({ ...view, phase: view.saved ? 'editing' : 'load_failed', pending: null, status: { kind: 'failed', code: 'unavailable', retryable: false } });
  }

  async function readPicker(): Promise<void> {
    emit({ ...view, picker: { kind: 'loading' } });
    try {
      const result = await ports.settings.knownPrincipals();
      if (disposed) return;
      emit({ ...view, picker: result.kind === 'ok' ? { kind: 'ready', principals: result.value } : { kind: 'failed' } });
    } catch {
      if (!disposed) emit({ ...view, picker: { kind: 'failed' } });
    }
  }

  function canEdit(): boolean {
    return !disposed && view.phase === 'editing' && !view.readOnly && view.saved !== null;
  }

  /** Applies a confirmed mutation locally so the view reflects the saved server state. */
  function applySaved(edit: PendingEdit, applied: MutationApplied): void {
    const saved = view.saved!;
    let next: ChannelSettingsSnapshot;
    let status: ChannelSettingsStatus;
    if (edit.kind === 'visibility') {
      next = { ...saved, visibility: edit.visibility, listedTitle: edit.title, revision: applied.revision ?? saved.revision };
      status = { kind: 'saved', visibility: edit.visibility };
    } else if (edit.kind === 'allow') {
      const agent = toAllowlisted(edit.agent);
      next = {
        ...saved,
        revision: applied.revision ?? saved.revision,
        allowlist: [...saved.allowlist.filter(item => item.principal !== agent.principal), agent],
      };
      status = { kind: 'allowed', fingerprint: agent.fingerprint };
    } else {
      next = {
        ...saved,
        revision: applied.revision ?? saved.revision,
        allowlist: saved.allowlist.filter(item => item.principal !== edit.agent.principal),
      };
      status = { kind: 'revoked', fingerprint: edit.agent.fingerprint };
    }
    operationId = null;
    emit(fromSnapshot(next, status));
  }

  async function submit(edit: PendingEdit): Promise<void> {
    const saved = view.saved!;
    operationId ??= createId();
    emit({ ...view, phase: 'submitting', pending: edit, status: { kind: 'idle' } });
    let result: OperationResult<MutationApplied, string>;
    try {
      if (edit.kind === 'visibility') {
        result = await ports.settings.setVisibility({
          v: 1, operationId, roomId, visibility: edit.visibility, title: edit.title, expectedRevision: saved.revision,
        });
      } else {
        const agent = edit.agent;
        result = await ports.settings.updateAllowlist({
          v: 1,
          action: edit.kind,
          operationId,
          roomId,
          principal: agent.principal,
          expectedSessionGeneration: agent.sessionGeneration,
          // Allowlist edits are only offered on a registered channel.
          expectedRevision: saved.revision!,
        });
      }
    } catch {
      result = { kind: 'unavailable', retryable: true };
    }
    if (disposed) return;
    if (result.kind === 'ok') {
      applySaved(edit, result.value);
      return;
    }
    if (result.kind === 'rejected') {
      operationId = null;
      if (result.code === 'forbidden') return loseAuthority();
      if (result.code === 'stale_revision') {
        // Someone else changed the channel (or the agent rebound): reload
        // both before the owner decides again. Nothing was saved.
        void readPicker();
        return readSettings({ kind: 'stale_refreshed' });
      }
      if (result.code === 'invalid_title') {
        emit({ ...view, phase: 'editing', pending: null, titleError: 'title_invalid', status: { kind: 'failed', code: 'invalid_title', retryable: false } });
        return;
      }
      emit({ ...view, phase: 'editing', pending: null, status: { kind: 'failed', code: result.code, retryable: false } });
      return;
    }
    // Unavailable or unknown: the edit and its operation ID stay pending so
    // `retry()` can resolve what happened without implying success.
    emit({ ...view, phase: 'editing', pending: edit, status: { kind: 'failed', code: 'unavailable', retryable: true } });
  }

  return {
    getView: () => view,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    load() {
      if (disposed || view.phase === 'submitting' || view.phase === 'confirming') return;
      if (view.saved === null) emit({ ...view, phase: 'loading', status: { kind: 'idle' } });
      void readSettings({ kind: 'idle' });
      void readPicker();
    },

    setVisibility(visibility) {
      if (!canEdit()) return;
      if (visibility === 'public' && view.saved!.publicDiscovery !== 'enabled') return;
      operationId = null;
      emit({ ...withDraft(view, visibility, view.draftTitle), pending: null, status: { kind: 'idle' } });
    },

    setTitle(title) {
      if (!canEdit()) return;
      operationId = null;
      emit({ ...withDraft(view, view.draftVisibility, title), pending: null, status: { kind: 'idle' } });
    },

    save() {
      if (!canEdit()) return;
      const saved = view.saved!;
      const visibility = view.draftVisibility;
      const title = visibility === 'secret' ? null : view.draftTitle.trim();
      if (title !== null) {
        if (title === '') return emit({ ...view, titleError: 'title_required' });
        if (projectListing(visibility, title).kind !== 'listed') return emit({ ...view, titleError: 'title_invalid' });
      }
      if (visibility === saved.visibility && title === saved.listedTitle) return;
      const edit: PendingEdit = { kind: 'visibility', visibility, title };
      if (isVisibilityIncrease(saved.visibility, visibility)) {
        emit({ ...view, phase: 'confirming', pending: edit, status: { kind: 'idle' } });
        return;
      }
      void submit(edit);
    },

    confirm() {
      if (disposed || view.phase !== 'confirming' || view.pending === null) return;
      void submit(view.pending);
    },

    cancel() {
      if (disposed || view.phase !== 'confirming') return;
      operationId = null;
      emit(fromSnapshot(view.saved!, { kind: 'idle' }));
    },

    allow(principal) {
      if (!canEdit() || view.saved!.visibility !== 'private' || view.saved!.revision === null || view.picker.kind !== 'ready') return;
      // Only an entry the owner-only picker offered can be allowed, exactly as offered.
      const agent = view.picker.principals.find(item => item.principal === principal);
      if (!agent) return;
      operationId = null;
      void submit({ kind: 'allow', agent });
    },

    revoke(principal) {
      if (!canEdit() || view.saved!.revision === null) return;
      const agent = view.saved!.allowlist.find(item => item.principal === principal);
      if (!agent) return;
      operationId = null;
      void submit({ kind: 'revoke', agent });
    },

    retry() {
      if (disposed || view.phase !== 'editing' || view.status.kind !== 'failed' || !view.status.retryable || view.pending === null) return;
      void submit(view.pending);
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
