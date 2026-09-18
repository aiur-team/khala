import { describe, expect, it } from 'vitest';
import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import type { BindingId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import { createReviewController } from './controller';
import type { ReviewView } from './model';
import type { ApprovalUiResult, ReviewUiPort } from './ports';
import { toSnapshot } from './selection';

const roomId = 'room_1' as RoomId;
const bindingId = 'bind_1' as BindingId;

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
  return { ref: eventRef, content: { v: 1, kind: 'text', body }, participant: participant('peer'), clientTxnId: null, receivedAt: '2026-09-17T00:00:00Z' };
}

const viewerOwnerId = 'owner_viewer' as OwnerId;

function view(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    access: 'ready',
    bindingId,
    bindingGeneration: 0,
    policyVersion: 3,
    viewerOwnerId,
    pending: [item(ref('event-a'), 'hello')],
    receipts: [],
    ...overrides,
  };
}

function createFakePort(initial: ReviewView) {
  let current = initial;
  const listeners = new Set<() => void>();
  let approveImpl: (command: ApprovalCommand) => Promise<ApprovalUiResult> = async () => ({ kind: 'accepted', releaseIds: ['release_1' as ReleaseId] });
  let approveCalls = 0;

  const port: ReviewUiPort = {
    snapshot: () => current,
    subscribe: (listener, signal) => {
      listeners.add(listener);
      const remove = () => listeners.delete(listener);
      signal.addEventListener('abort', remove, { once: true });
      return remove;
    },
    approve: async command => {
      approveCalls += 1;
      return approveImpl(command);
    },
  };

  return {
    port,
    setView(next: ReviewView) {
      current = next;
      listeners.forEach(listener => listener());
    },
    setApprove(fn: (command: ApprovalCommand) => Promise<ApprovalUiResult>) {
      approveImpl = fn;
    },
    get approveCalls() {
      return approveCalls;
    },
  };
}

describe('review controller', () => {
  it('starts idle with an empty selection', () => {
    const fake = createFakePort(view());
    const controller = createReviewController(fake.port);
    const data = controller.getSnapshot();
    expect(data.selection.phase).toBe('viewing');
    expect(data.submission.phase).toBe('idle');
    controller.dispose();
  });

  it('submit sends one command and adopts released release IDs on acceptance', async () => {
    const fake = createFakePort(view());
    fake.setApprove(async command => ({ kind: 'accepted', releaseIds: [`release_for_${command.commandId}` as ReleaseId] }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    expect(controller.getSnapshot().selection.phase).toBe('selected');

    await controller.submit();

    const data = controller.getSnapshot();
    expect(data.submission.phase).toBe('released');
    expect(data.submission.releaseIds).toHaveLength(1);
    expect(data.selection.phase).toBe('viewing');
    expect(fake.approveCalls).toBe(1);
    controller.dispose();
  });

  it('U3: a lost response retains unknown and disables blind resubmit; the same command reconciled adopts release IDs', async () => {
    const fake = createFakePort(view());
    fake.setApprove(async command => ({ kind: 'outcome_unknown', commandId: command.commandId }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    await controller.submit();

    let data = controller.getSnapshot();
    expect(data.submission.phase).toBe('unknown');
    const commandId = data.submission.commandId;
    expect(commandId).not.toBeNull();

    // A blind resubmit while unknown is a no-op: no second approve call.
    await controller.submit();
    expect(fake.approveCalls).toBe(1);

    // Reconciling adopts the release IDs from the *same* command identity.
    fake.setApprove(async command => {
      expect(command.commandId).toBe(commandId);
      return { kind: 'accepted', releaseIds: ['release_reconciled' as ReleaseId] };
    });
    await controller.reconcileUnknown();

    data = controller.getSnapshot();
    expect(data.submission.phase).toBe('released');
    expect(data.submission.commandId).toBe(commandId);
    expect(data.submission.releaseIds).toEqual(['release_reconciled']);
    expect(fake.approveCalls).toBe(2);
    controller.dispose();
  });

  it('U3: revocation removes preview and clears command authority even ahead of a late unknown response', async () => {
    const fake = createFakePort(view());
    fake.setApprove(async command => ({ kind: 'outcome_unknown', commandId: command.commandId }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    await controller.submit();
    expect(controller.getSnapshot().submission.phase).toBe('unknown');

    // The fake port here deliberately does NOT empty `pending` on revocation —
    // the controller itself must clear the protected preview regardless of
    // what the port snapshot still carries.
    fake.setView(view({ access: 'revoked', pending: [item(ref('event-a'), 'hello')] }));

    const data = controller.getSnapshot();
    expect(data.view.access).toBe('revoked');
    expect(data.view.pending).toEqual([]);
    expect(data.selection.phase).toBe('viewing');
    expect(data.submission.phase).toBe('idle');
    expect(data.submission.commandId).toBeNull();

    // The late response, once it eventually resolves, cannot be reconciled: authority was already cleared.
    await controller.reconcileUnknown();
    expect(controller.getSnapshot().submission.phase).toBe('idle');
    controller.dispose();
  });

  it('a submit response that lands after revocation never resurrects cleared submission/command authority', async () => {
    const fake = createFakePort(view());
    let resolveApprove!: (result: ApprovalUiResult) => void;
    fake.setApprove(() => new Promise<ApprovalUiResult>(resolve => (resolveApprove = resolve)));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    const submitted = controller.submit();
    expect(controller.getSnapshot().submission.phase).toBe('submitting');

    // Revocation lands while the request is still in flight; the fake port
    // again does not empty `pending` itself.
    fake.setView(view({ access: 'revoked', pending: [item(ref('event-a'), 'hello')] }));
    expect(controller.getSnapshot().submission.phase).toBe('idle');
    expect(controller.getSnapshot().view.pending).toEqual([]);

    // The original in-flight request finally resolves as accepted — too late to matter.
    resolveApprove({ kind: 'accepted', releaseIds: ['release_1' as ReleaseId] });
    await submitted;

    const data = controller.getSnapshot();
    expect(data.submission.phase).toBe('idle');
    expect(data.submission.releaseIds).toBeNull();
    expect(data.view.access).toBe('revoked');
    controller.dispose();
  });

  it('toggling selection while a command is submitting/unknown is a no-op, so an unsubmitted edit is never silently discarded on success', async () => {
    const fake = createFakePort(view({ pending: [item(ref('event-a'), 'a'), item(ref('event-b'), 'b')] }));
    let resolveApprove!: (result: ApprovalUiResult) => void;
    fake.setApprove(() => new Promise<ApprovalUiResult>(resolve => (resolveApprove = resolve)));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    const submitted = controller.submit();
    expect(controller.getSnapshot().submission.phase).toBe('submitting');

    // Attempting to change the selection while the command targeting {event-a} is in flight has no effect.
    controller.toggleSelect(ref('event-a'), false);
    controller.toggleSelect(ref('event-b'), true);
    expect(controller.getSnapshot().selection.refs.map(r => r.eventId)).toEqual(['event-a']);

    resolveApprove({ kind: 'accepted', releaseIds: ['release_1' as ReleaseId] });
    await submitted;
    controller.dispose();
  });

  it('rejects a definite non-stale error and preserves the closed-vocabulary code, without disturbing the selection', async () => {
    const fake = createFakePort(view());
    fake.setApprove(async () => ({ kind: 'rejected', code: 'forbidden' }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    await controller.submit();
    const data = controller.getSnapshot();
    expect(data.submission.phase).toBe('rejected');
    expect(data.submission.error).toBe('forbidden');
    expect(data.selection.phase).toBe('selected');
    controller.dispose();
  });

  it('a server-observed stale_content/stale_binding/stale_policy rejection shows the same stale/refresh state as a local staleness, with Release disabled', async () => {
    const fake = createFakePort(view());
    fake.setApprove(async () => ({ kind: 'rejected', code: 'stale_content' }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    await controller.submit();
    const data = controller.getSnapshot();
    expect(data.submission.phase).toBe('rejected');
    expect(data.submission.error).toBe('stale_content');
    // The selection itself moves to `stale`, the same state AE1 uses locally —
    // Release must be disabled, not left active beside a raw error code.
    expect(data.selection.phase).toBe('stale');
    expect(toSnapshot(data.selection)).toBeNull();
    controller.dispose();
  });

  it('an outcome_unknown result adopts the commandId of the command actually sent, never a value read back from the result', async () => {
    const fake = createFakePort(view());
    // The fake connector deliberately returns a different commandId than the one sent.
    fake.setApprove(async () => ({ kind: 'outcome_unknown', commandId: 'cmd_from_the_wire_not_ours' as never }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    await controller.submit();
    const data = controller.getSnapshot();
    expect(data.submission.phase).toBe('unknown');
    expect(data.submission.commandId).not.toBe('cmd_from_the_wire_not_ours');
    controller.dispose();
  });

  it('the command selects only the chosen refs, never every pending item', async () => {
    const fake = createFakePort(view({ pending: [item(ref('event-a'), 'a'), item(ref('event-b'), 'b'), item(ref('event-c'), 'c')] }));
    let sentSelection: readonly string[] = [];
    fake.setApprove(async command => {
      sentSelection = command.selection.map(r => r.eventId);
      return { kind: 'accepted', releaseIds: ['release_1' as ReleaseId] };
    });
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-b'), true);
    await controller.submit();
    expect(sentSelection).toEqual(['event-b']);
    controller.dispose();
  });

  it('the command orders the selection in display (pending) order, never click order', async () => {
    const fake = createFakePort(view({ pending: [item(ref('event-a'), 'a'), item(ref('event-b'), 'b'), item(ref('event-c'), 'c')] }));
    let sentSelection: readonly string[] = [];
    fake.setApprove(async command => {
      sentSelection = command.selection.map(r => r.eventId);
      return { kind: 'accepted', releaseIds: ['release_1' as ReleaseId] };
    });
    const controller = createReviewController(fake.port);
    // Click order is c, then a, then b — the reverse-ish of display order.
    controller.toggleSelect(ref('event-c'), true);
    controller.toggleSelect(ref('event-a'), true);
    controller.toggleSelect(ref('event-b'), true);
    await controller.submit();
    expect(sentSelection).toEqual(['event-a', 'event-b', 'event-c']);
    controller.dispose();
  });

  it('a port change never reconciles an outcome_unknown submission on its own — only an explicit reconcileUnknown does', async () => {
    const fake = createFakePort(view());
    fake.setApprove(async command => ({ kind: 'outcome_unknown', commandId: command.commandId }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    await controller.submit();
    expect(controller.getSnapshot().submission.phase).toBe('unknown');

    // An unrelated port change (a new arrival) must not silently resolve the pending command.
    fake.setView(view({ pending: [item(ref('event-a'), 'hello'), item(ref('event-b'), 'new arrival')] }));
    expect(controller.getSnapshot().submission.phase).toBe('unknown');
    expect(fake.approveCalls).toBe(1);
    controller.dispose();
  });

  it('toggling a ref that is not present and readable in the current pending set is rejected by the controller, not just the screen', () => {
    const fake = createFakePort(view({ pending: [item(ref('event-a'), 'a')] }));
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-does-not-exist'), true);
    expect(controller.getSnapshot().selection.phase).toBe('viewing');
    controller.dispose();
  });

  it('a new event arriving via the port never joins an existing selection', () => {
    const fake = createFakePort(view());
    const controller = createReviewController(fake.port);
    controller.toggleSelect(ref('event-a'), true);
    fake.setView(view({ pending: [item(ref('event-a'), 'hello'), item(ref('event-b'), 'new arrival')] }));
    const data = controller.getSnapshot();
    expect(data.selection.refs.map(r => r.eventId)).toEqual(['event-a']);
  });

  it('dispose is idempotent and unsubscribes the port observer exactly once', () => {
    const fake = createFakePort(view());
    const controller = createReviewController(fake.port);
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
    fake.setView(view({ access: 'unavailable' }));
    // No listener remains subscribed, so getSnapshot still reflects the pre-dispose cached data.
    expect(controller.getSnapshot().view.access).toBe('ready');
  });
});
