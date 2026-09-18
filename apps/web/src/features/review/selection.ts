// Pure, React-free exact review selection. Bound to exact `EventRef` identity
// and content digest plus a captured binding generation/policy version — never
// row numbers or mutable rendered text (KTD1). A live arrival never joins an
// existing selection: selection only ever changes through `addRef`/`removeRef`.
// Once a captured selection no longer matches the current pending items or
// binding/policy context, it moves to `stale` and stays there until the human
// explicitly clears it (AE1) — this module never silently re-targets or
// broadens a selection.

import type { BindingId } from '@khala/contracts/delivery/ids';
import type { EventRef, MessageContent, TimelineItem } from '@khala/contracts/messaging/index';
import { sameEventRef } from '@khala/contracts/messaging/index';
import type { SelectionPhase, SelectionSnapshot } from './model';

export type BindingContext = Readonly<{ bindingId: BindingId; bindingGeneration: number; policyVersion: number }>;

export type SelectionState = Readonly<{
  phase: SelectionPhase;
  refs: readonly EventRef[];
  captured: BindingContext | null;
}>;

export function emptySelection(): SelectionState {
  return { phase: 'viewing', refs: [], captured: null };
}

/** True only for an item with recoverable text content; an unavailable placeholder is never selectable. */
export function isReadableItem(item: TimelineItem): item is Extract<TimelineItem, { content: MessageContent }> {
  return item.content.kind === 'text';
}

/** True only when `ref` identifies a readable item actually present in `pending` right now. */
function isSelectableRef(ref: EventRef, pending: readonly TimelineItem[]): boolean {
  return pending.some(item => isReadableItem(item) && sameEventRef(item.ref, ref));
}

export function isSelected(state: SelectionState, ref: EventRef): boolean {
  return state.refs.some(existing => sameEventRef(existing, ref));
}

/**
 * Adds one exact reference to the selection. A ref already present (by exact
 * field equality) is rejected as a no-op duplicate, never stored twice. Has no
 * effect once the selection is `stale` — the human must `clearSelection` first.
 * A ref that is not currently present and readable in `pending` — an
 * unavailable placeholder, or one no longer in the pending set at all — is
 * rejected the same way; the model itself never accepts it, regardless of
 * what the screen shows.
 */
export function addRef(state: SelectionState, ref: EventRef, binding: BindingContext, pending: readonly TimelineItem[]): SelectionState {
  if (state.phase === 'stale') return state;
  if (isSelected(state, ref)) return state;
  if (!isSelectableRef(ref, pending)) return state;
  return { phase: 'selected', refs: [...state.refs, ref], captured: binding };
}

/** Removes one exact reference. Dropping the last reference returns to `viewing`. */
export function removeRef(state: SelectionState, ref: EventRef): SelectionState {
  if (state.phase === 'stale') return state;
  const refs = state.refs.filter(existing => !sameEventRef(existing, ref));
  if (refs.length === 0) return emptySelection();
  return { phase: 'selected', refs, captured: state.captured };
}

/** Explicit human reselect: returns a stale (or any) selection to empty `viewing`. */
export function clearSelection(): SelectionState {
  return emptySelection();
}

/**
 * Re-checks a `selected` selection against the current pending items and
 * binding/policy context. Any changed digest, a selected item that is no
 * longer present or readable, or a binding/policy generation change moves the
 * selection to `stale`; a merely-arrived new item never joins it.
 */
export function reconcileSelection(
  state: SelectionState,
  pending: readonly TimelineItem[],
  binding: BindingContext,
): SelectionState {
  if (state.phase !== 'selected' || state.captured === null) return state;
  const bindingChanged = state.captured.bindingId !== binding.bindingId
    || state.captured.bindingGeneration !== binding.bindingGeneration
    || state.captured.policyVersion !== binding.policyVersion;
  if (bindingChanged) return { ...state, phase: 'stale' };
  const stillExact = state.refs.every(ref => pending.some(item => isReadableItem(item) && sameEventRef(item.ref, ref)));
  return stillExact ? state : { ...state, phase: 'stale' };
}

export function toSnapshot(state: SelectionState): SelectionSnapshot | null {
  if (state.phase !== 'selected' || state.captured === null) return null;
  return {
    bindingId: state.captured.bindingId,
    bindingGeneration: state.captured.bindingGeneration,
    expectedPolicyVersion: state.captured.policyVersion,
    references: state.refs,
  };
}
