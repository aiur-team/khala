import { describe, expect, it } from 'vitest';
import type { BindingId } from '@khala/contracts/delivery/ids';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import {
  addRef, clearSelection, emptySelection, isSelected, reconcileSelection, removeRef, toSnapshot, type BindingContext,
} from './selection';

const roomId = 'room_1' as RoomId;

function participant(id: string): ParticipantView {
  return { participantId: id as ParticipantId, kind: 'human', ownerId: `owner_${id}` as OwnerId, displayName: id, deviceIds: [] };
}

function ref(eventId: string, digest = 'a'.repeat(64)): EventRef {
  return {
    v: 1,
    roomId,
    eventId: eventId as EventId,
    authorParticipantId: 'peer' as ParticipantId,
    authorDeviceId: 'device_peer' as DeviceId,
    contentDigest: `sha256:${digest}`,
  };
}

function item(eventRef: EventRef, body: string): TimelineItem {
  return {
    ref: eventRef,
    content: { v: 1, kind: 'text', body },
    participant: participant('peer'),
    clientTxnId: null,
    receivedAt: '2026-09-17T00:00:00Z',
  };
}

function unavailableItem(eventId: string): TimelineItem {
  return {
    ref: { v: 1, roomId, eventId: eventId as EventId, authorParticipantId: 'peer' as ParticipantId, authorDeviceId: 'device_peer' as DeviceId },
    content: { v: 1, kind: 'unavailable', reason: 'withheld' },
    participant: participant('peer'),
    clientTxnId: null,
    receivedAt: '2026-09-17T00:00:00Z',
  };
}

const binding: BindingContext = { bindingId: 'bind_1' as BindingId, bindingGeneration: 0, policyVersion: 3 };

describe('review selection', () => {
  it('AE1: an edited event (changed digest) invalidates a captured selection', () => {
    const refA = ref('event-a');
    const editedA = ref('event-a', 'b'.repeat(64));
    let state = addRef(emptySelection(), refA, binding, [item(refA, 'original body')]);
    expect(state.phase).toBe('selected');

    const reconciled = reconcileSelection(state, [item(editedA, 'edited body')], binding);
    expect(reconciled.phase).toBe('stale');
    expect(toSnapshot(reconciled)).toBeNull();

    // Explicit reselect returns to viewing; the old (stale) selection cannot release the new bytes.
    state = clearSelection();
    expect(state.phase).toBe('viewing');
  });

  it('AE1: a binding generation change invalidates a captured selection', () => {
    const refA = ref('event-a');
    const state = addRef(emptySelection(), refA, binding, [item(refA, 'unchanged')]);
    const rebound: BindingContext = { ...binding, bindingGeneration: binding.bindingGeneration + 1 };
    const reconciled = reconcileSelection(state, [item(refA, 'unchanged')], rebound);
    expect(reconciled.phase).toBe('stale');
  });

  it('a policy version change invalidates a captured selection', () => {
    const refA = ref('event-a');
    const state = addRef(emptySelection(), refA, binding, [item(refA, 'unchanged')]);
    const repolicied: BindingContext = { ...binding, policyVersion: binding.policyVersion + 1 };
    const reconciled = reconcileSelection(state, [item(refA, 'unchanged')], repolicied);
    expect(reconciled.phase).toBe('stale');
  });

  it('a new event arriving during selection never joins the selection', () => {
    const refA = ref('event-a');
    const refB = ref('event-b');
    const state = addRef(emptySelection(), refA, binding, [item(refA, 'a')]);
    // refB arrives in the pending set but was never explicitly added.
    const reconciled = reconcileSelection(state, [item(refA, 'a'), item(refB, 'b')], binding);
    expect(reconciled.phase).toBe('selected');
    expect(isSelected(reconciled, refA)).toBe(true);
    expect(isSelected(reconciled, refB)).toBe(false);
    expect(toSnapshot(reconciled)?.references).toEqual([refA]);
  });

  it('two events sharing identical body content remain separately selectable objects', () => {
    const refA = ref('event-a');
    const refB = ref('event-b');
    const pending = [item(refA, 'same body'), item(refB, 'same body')];
    let state = addRef(emptySelection(), refA, binding, pending);
    state = addRef(state, refB, binding, pending);
    expect(state.refs).toHaveLength(2);
    expect(isSelected(state, refA)).toBe(true);
    expect(isSelected(state, refB)).toBe(true);
  });

  it('adding the same exact ref twice is rejected as a no-op, never stored twice', () => {
    const refA = ref('event-a');
    const pending = [item(refA, 'a')];
    let state = addRef(emptySelection(), refA, binding, pending);
    state = addRef(state, refA, binding, pending);
    expect(state.refs).toHaveLength(1);
  });

  it('removing the last selected ref returns to viewing with no snapshot', () => {
    const refA = ref('event-a');
    let state = addRef(emptySelection(), refA, binding, [item(refA, 'a')]);
    state = removeRef(state, refA);
    expect(state.phase).toBe('viewing');
    expect(toSnapshot(state)).toBeNull();
  });

  it('a stale selection ignores further add/remove until explicitly cleared', () => {
    const refA = ref('event-a');
    const refB = ref('event-b');
    let state = addRef(emptySelection(), refA, binding, [item(refA, 'a')]);
    state = reconcileSelection(state, [item(ref('event-a', 'b'.repeat(64)), 'edited')], binding);
    expect(state.phase).toBe('stale');
    const attemptedAdd = addRef(state, refB, binding, [item(refB, 'b')]);
    expect(attemptedAdd).toBe(state);
    state = clearSelection();
    expect(state.phase).toBe('viewing');
  });

  it('a ref not present in the current pending set is rejected, never added blind', () => {
    const refA = ref('event-a');
    // event-a is not in the pending set passed to addRef at all.
    const state = addRef(emptySelection(), refA, binding, [item(ref('event-b'), 'other')]);
    expect(state.phase).toBe('viewing');
    expect(isSelected(state, refA)).toBe(false);
  });

  it('an unavailable (undecryptable/withheld) item is never selectable, even by exact eventId', () => {
    const refA = ref('event-a');
    // The pending item at this eventId exists but is unavailable, so it carries
    // no digest and is structurally not an EventRef the model can select.
    const state = addRef(emptySelection(), refA, binding, [unavailableItem('event-a')]);
    expect(state.phase).toBe('viewing');
    expect(isSelected(state, refA)).toBe(false);
  });
});
