// Owns the generation-fenced `ReviewView` projection (mirroring timeline's
// `controller.ts` `useSyncExternalStore`-safe cached-snapshot pattern) layered
// over the injected `ReviewUiPort`, plus review-local selection and
// submission state — neither is part of the port's cached snapshot (KTD2
// style). Creates one stable `commandId` per submission; `outcome_unknown`
// reconciles the exact same command object already sent, never a freshly
// reconstructed one (U3).

import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import type { CommandId } from '@khala/contracts/delivery/ids';
import type { EventRef } from '@khala/contracts/messaging/index';
import type { ReviewView, SubmissionState } from './model';
import type { ApprovalUiResult, ReviewUiPort } from './ports';
import {
  addRef, clearSelection as clearSelectionState, emptySelection, reconcileSelection, removeRef, toSnapshot,
  type BindingContext, type SelectionState,
} from './selection';

export type ReviewData = Readonly<{
  view: ReviewView;
  selection: SelectionState;
  submission: SubmissionState;
}>;

export interface ReviewController {
  /** Cached, `useSyncExternalStore`-safe: returns the same reference until state changes. */
  getSnapshot(): ReviewData;
  subscribe(listener: () => void): () => void;
  toggleSelect(ref: EventRef, checked: boolean): void;
  clearSelection(): void;
  /** Submits the current selection as one new command. No-op while a command is `submitting`/`unknown`, or the selection is not `selected`, or access is not `ready`. */
  submit(): Promise<void>;
  /** Reconciles the last `outcome_unknown` command using its exact identity and bytes, never a freshly reconstructed one. No-op unless submission is `unknown`. */
  reconcileUnknown(): Promise<void>;
  /** Idempotent; unsubscribes the port observer exactly once. */
  dispose(): void;
}

const EMPTY_SUBMISSION: SubmissionState = { phase: 'idle', commandId: null, releaseIds: null, error: null };

function newCommandId(): CommandId {
  return `cmd_${crypto.randomUUID()}` as CommandId;
}

function bindingContextOf(view: ReviewView): BindingContext {
  return { bindingId: view.bindingId, bindingGeneration: view.bindingGeneration, policyVersion: view.policyVersion };
}

function buildCommand(commandId: CommandId, snapshot: NonNullable<ReturnType<typeof toSnapshot>>): ApprovalCommand {
  return {
    v: 1,
    commandId,
    roomId: snapshot.references[0]!.roomId,
    bindingId: snapshot.bindingId,
    expectedPolicyVersion: snapshot.expectedPolicyVersion,
    expectedBindingGeneration: snapshot.bindingGeneration,
    selection: snapshot.references,
    issuedAt: new Date().toISOString(),
  };
}

function mapResult(fallbackCommandId: CommandId, result: ApprovalUiResult): SubmissionState {
  switch (result.kind) {
    case 'accepted':
      return { phase: 'released', commandId: fallbackCommandId, releaseIds: result.releaseIds, error: null };
    case 'rejected':
      return { phase: 'rejected', commandId: fallbackCommandId, releaseIds: null, error: result.code };
    case 'outcome_unknown':
      return { phase: 'unknown', commandId: result.commandId, releaseIds: null, error: null };
  }
}

export function createReviewController(port: ReviewUiPort): ReviewController {
  let selection: SelectionState = emptySelection();
  let submission: SubmissionState = EMPTY_SUBMISSION;
  // The exact command last sent, kept for `outcome_unknown` reconciliation —
  // never rebuilt from current selection, which may have moved on.
  let lastCommand: ApprovalCommand | null = null;
  let disposed = false;
  const abortController = new AbortController();

  let cachedView: ReviewView = port.snapshot();
  let cachedData: ReviewData | null = null;
  let dataDirty = true;

  const listeners = new Set<() => void>();

  function getSnapshot(): ReviewData {
    if (!dataDirty && cachedData) return cachedData;
    cachedData = { view: cachedView, selection, submission };
    dataDirty = false;
    return cachedData;
  }

  function notify(): void {
    dataDirty = true;
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function onPortChange(): void {
    if (disposed) return;
    cachedView = port.snapshot();
    // Revocation clears protected preview and command authority immediately,
    // even ahead of a late in-flight response (Failure boundaries).
    if (cachedView.access === 'revoked') {
      selection = emptySelection();
      submission = EMPTY_SUBMISSION;
      lastCommand = null;
    } else {
      selection = reconcileSelection(selection, cachedView.pending, bindingContextOf(cachedView));
    }
    notify();
  }

  const unsubscribePort = port.subscribe(onPortChange, abortController.signal);

  function toggleSelect(ref: EventRef, checked: boolean): void {
    if (disposed || cachedView.access !== 'ready') return;
    selection = checked ? addRef(selection, ref, bindingContextOf(cachedView)) : removeRef(selection, ref);
    notify();
  }

  function clearSelection(): void {
    if (disposed) return;
    selection = clearSelectionState();
    notify();
  }

  async function runApprove(command: ApprovalCommand): Promise<void> {
    lastCommand = command;
    submission = { phase: 'submitting', commandId: command.commandId, releaseIds: null, error: null };
    notify();
    let result: ApprovalUiResult;
    try {
      result = await port.approve(command, abortController.signal);
    } catch {
      result = { kind: 'outcome_unknown', commandId: command.commandId };
    }
    if (disposed) return;
    submission = mapResult(command.commandId, result);
    if (submission.phase === 'released') {
      selection = emptySelection();
      lastCommand = null;
    }
    notify();
  }

  async function submit(): Promise<void> {
    if (disposed || cachedView.access !== 'ready') return;
    if (submission.phase === 'submitting' || submission.phase === 'unknown') return;
    const snapshot = toSnapshot(selection);
    if (!snapshot) return;
    await runApprove(buildCommand(newCommandId(), snapshot));
  }

  async function reconcileUnknown(): Promise<void> {
    if (disposed || submission.phase !== 'unknown' || !lastCommand) return;
    await runApprove(lastCommand);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    abortController.abort();
    unsubscribePort();
  }

  return { getSnapshot, subscribe, toggleSelect, clearSelection, submit, reconcileUnknown, dispose };
}
