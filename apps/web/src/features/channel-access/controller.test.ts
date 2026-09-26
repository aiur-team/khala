import { describe, expect, it } from 'vitest';
import { CHANNEL_ACCESS_REQUEST_LIFETIME_MS, CHANNEL_ACCESS_SENSITIVE_RETENTION_MS } from '@khala/contracts/messaging/index';
import { createChannelAccessInboxController } from './controller';
import { createFakeJournal, fixtureDigest, type FakeJournal } from './fakes';
import { pendingIndicator } from './model';

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

function setup(journal: FakeJournal = createFakeJournal()) {
  let ids = 0;
  const operationIds: string[] = [];
  const controller = createChannelAccessInboxController(
    { requests: journal.port },
    {
      createId: () => {
        ids += 1;
        operationIds.push(`op-${ids}`);
        return `op-${ids}`;
      },
      now: () => journal.now(),
    },
  );
  const decideCalls: Array<{ operationId: string; expectedRevision: string; decision: string }> = [];
  const decide = journal.port.decide.bind(journal.port);
  journal.port.decide = async (input, options) => {
    decideCalls.push({ operationId: input.operationId, expectedRevision: input.expectedRevision, decision: input.decision });
    return decide(input, options);
  };
  controller.start();
  return { journal, controller, decideCalls, operationIds };
}

const ACCESS = { kind: 'access', title: 'Release planning', fingerprint: 'agent-one', displayLabel: 'build bot' } as const;
const SECOND = { kind: 'access', title: 'Release planning', fingerprint: 'agent-two', displayLabel: 'build bot' } as const;
const CREATE = { kind: 'create', title: 'Scratch room', fingerprint: 'agent-one' } as const;

describe('channel-access inbox controller', () => {
  it('loads the decoded inbox, leaves out anything the contract refuses, and counts pending exactly', async () => {
    const journal = createFakeJournal();
    journal.submit(ACCESS);
    const inbox = journal.port.inbox.bind(journal.port);
    journal.port.inbox = async () => {
      const result = await inbox();
      if (result.kind !== 'ok') return result;
      // A row with a malformed request handle must never render.
      return { kind: 'ok', value: [...result.value, { ...(result.value[0] as object), requestHandle: 'careq_bad', revision: '1' }] };
    };
    const { controller } = setup(journal);
    await flush();
    const view = controller.getView();
    expect(view.phase).toBe('ready');
    expect(view.requests).toHaveLength(1);
    expect(view.rejectedCount).toBe(1);
    expect(pendingIndicator(view.requests)).toBe(1);
  });

  it('never opens a request from a notification; it only adds a notice and refreshes', async () => {
    const { journal, controller } = setup();
    await flush();
    journal.submit(ACCESS);
    await flush();
    const view = controller.getView();
    expect(view.dialog).toBeNull();
    expect(view.notices).toHaveLength(1);
    expect(view.requests).toHaveLength(1);
  });

  it('wrong-implementation guard: closing the first of two queued requests never opens the second', async () => {
    const { journal, controller } = setup();
    const first = journal.submit(ACCESS)!;
    journal.submit(SECOND);
    await flush();
    controller.open(first);
    controller.decide('approve');
    await flush();
    expect(controller.getView().dialog?.status.kind).toBe('decided');
    controller.close();
    expect(controller.getView().dialog).toBeNull();
    await flush();
    expect(controller.getView().dialog).toBeNull();

    // Closing without deciding does not advance either.
    const second = controller.getView().requests.find(request => request.outcome === 'pending_owner')!;
    journal.submit({ ...ACCESS, fingerprint: 'agent-three' });
    await flush();
    controller.open(second.requestHandle);
    controller.close();
    expect(controller.getView().dialog).toBeNull();
  });

  it('notification selection and direct navigation reach the same row', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    const notice = controller.getView().notices[0]!;
    controller.openNotice(notice.notificationId);
    const fromNotice = controller.getView();
    controller.select(handle);
    const fromLink = controller.getView();
    expect(fromNotice.selected).toBe(handle);
    expect(fromLink.selected).toBe(handle);
    expect(fromLink.selectionSequence).toBe(fromNotice.selectionSequence + 1);
    expect(fromNotice.notices).toHaveLength(0);
    expect(fromNotice.dialog).toBeNull();
  });

  it('a batch notification selects the whole list', async () => {
    const { journal, controller } = setup();
    journal.publishBatch(7);
    await flush();
    const notice = controller.getView().notices.find(item => item.requestHandle === null)!;
    expect(notice.count).toBe(7);
    controller.openNotice(notice.notificationId);
    expect(controller.getView().selected).toBeNull();
  });

  it('dismissing a notification keeps the pending row, and the same revision does not come back', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    const notice = controller.getView().notices[0]!;
    controller.dismissNotice(notice.notificationId);
    expect(controller.getView().notices).toHaveLength(0);
    expect(controller.getView().requests.map(request => request.requestHandle)).toContain(handle);
    await flush();
    expect(controller.getView().notices).toHaveLength(0);
  });

  it('keeps the dialog and projection on a retryable failure, refreshes the revision, and retries the same operation', async () => {
    const { journal, controller, decideCalls } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    const shown = controller.getView().dialog!.request;
    journal.failNext.decide.push('unavailable');
    controller.decide('approve');
    await flush();
    let dialog = controller.getView().dialog!;
    expect(dialog.status.kind).toBe('retryable');
    expect(dialog.request.requester.sessionFingerprint).toBe(shown.requester.sessionFingerprint);

    // Something else touched the request meanwhile; the retry carries the refreshed revision.
    journal.bumpRevision(handle);
    controller.refresh();
    await flush();
    expect(controller.getView().dialog!.request.revision).toBe('carev_2');
    controller.retry();
    await flush();
    dialog = controller.getView().dialog!;
    expect(dialog.status.kind).toBe('decided');
    expect(decideCalls).toHaveLength(2);
    expect(decideCalls[1]!.operationId).toBe(decideCalls[0]!.operationId);
    expect(decideCalls[1]!.expectedRevision).toBe('carev_2');
    expect(journal.rows().find(row => row.requestHandle === handle)!.ownerDecision).toBe('approved');
  });

  it('a lost response for a recorded decision reconciles to decided without a second decision', async () => {
    const { journal, controller, decideCalls } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    journal.failNext.decide.push('unknown_after_commit');
    controller.decide('deny');
    await flush();
    expect(controller.getView().dialog!.status.kind).toBe('decided');
    expect(decideCalls).toHaveLength(1);
    // A retry now would reuse the same operation and be answered idempotently.
    controller.retry();
    await flush();
    expect(decideCalls).toHaveLength(1);
  });

  it('a stale revision reloads the request and lets the owner decide again', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    journal.bumpRevision(handle);
    controller.decide('approve');
    await flush();
    expect(controller.getView().dialog!.status.kind).toBe('refreshed');
    expect(controller.getView().dialog!.request.revision).toBe('carev_2');
    controller.decide('approve');
    await flush();
    expect(controller.getView().dialog!.status.kind).toBe('decided');
  });

  it('a decision made elsewhere blocks this one', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    journal.decideElsewhere(handle, 'deny');
    controller.refresh();
    await flush();
    expect(controller.getView().dialog!.status.kind).toBe('blocked');
  });

  for (const caller of ['other_owner', 'binding_capability', 'discovery_capability'] as const) {
    it(`rejects a decision and a mute from ${caller} and turns the inbox read-only`, async () => {
      const { journal, controller } = setup();
      const handle = journal.submit(ACCESS)!;
      await flush();
      controller.open(handle);
      journal.setCaller(caller);
      controller.decide('approve');
      await flush();
      const view = controller.getView();
      expect(view.readOnly).toBe(true);
      expect(view.dialog!.status.kind).toBe('blocked');
      expect(journal.rows()[0]!.ownerDecision).toBe('pending');
      controller.toggleMute(handle);
      await flush();
      expect(journal.calls.setMute).toBe(0);
      controller.refresh();
      await flush();
      expect(controller.getView().status.kind).toBe('authority_lost');
    });
  }

  it('an access mute is requester/channel scoped; a creation mute is requester/owner scoped', async () => {
    const { journal, controller } = setup();
    const access = journal.submit(ACCESS)!;
    const create = journal.submit(CREATE)!;
    await flush();
    controller.toggleMute(access);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'muted', muted: true, operationKind: 'access' });
    expect(journal.submit(ACCESS)).toBeNull();
    expect(journal.submit({ ...ACCESS, title: 'Another channel' })).not.toBeNull();
    expect(journal.submit(CREATE)).not.toBeNull();

    await flush();
    controller.toggleMute(create);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'muted', muted: true, operationKind: 'create' });
    expect(journal.submit(CREATE)).toBeNull();
    expect(journal.submit({ ...CREATE, fingerprint: 'agent-two' })).not.toBeNull();
    expect(journal.isMuted('create', 'agent-one')).toBe(true);
  });

  it('an access mute needs current ownership of that channel', async () => {
    const { journal, controller } = setup();
    const access = journal.submit(ACCESS)!;
    const create = journal.submit(CREATE)!;
    await flush();
    journal.loseChannel(ACCESS.title);
    controller.toggleMute(access);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'mute_failed', code: 'forbidden' });
    controller.toggleMute(create);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'muted', muted: true, operationKind: 'create' });
  });

  it('a stale mute revision reloads and changes nothing', async () => {
    const { journal, controller } = setup();
    const access = journal.submit(ACCESS)!;
    await flush();
    // Another window mutes first.
    await journal.port.setMute({ v: 1, requestHandle: access, expectedRevision: null, action: 'mute', operationId: 'other-window' });
    controller.toggleMute(access);
    await flush();
    expect(controller.getView().status.kind).toBe('mute_refreshed');
    const row = controller.getView().requests[0]!;
    expect(row.muted).toBe(true);
    expect(row.muteRevision).toBe('carev_1');
    controller.toggleMute(access);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'muted', muted: false, operationKind: 'access' });
  });

  it('a retryable mute failure reuses its operation ID on the next attempt', async () => {
    const { journal, controller, operationIds } = setup();
    const access = journal.submit(ACCESS)!;
    await flush();
    journal.failNext.setMute.push('unavailable');
    controller.toggleMute(access);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'mute_failed', code: 'unavailable' });
    controller.toggleMute(access);
    await flush();
    expect(operationIds).toHaveLength(1);
    expect(controller.getView().requests[0]!.muted).toBe(true);
  });

  it('expires a request at its deadline and refuses a late decision', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    journal.advanceClock(CHANNEL_ACCESS_REQUEST_LIFETIME_MS);
    controller.decide('approve');
    await flush();
    const view = controller.getView();
    expect(view.dialog!.status).toMatchObject({ kind: 'blocked' });
    expect(view.requests[0]!.outcome).toBe('expired');
    expect(pendingIndicator(view.requests)).toBe(0);
  });

  it('removes terminal sensitive context after the 30-day retention limit, even from an open dialog', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    controller.decide('deny');
    await flush();
    journal.advanceClock(CHANNEL_ACCESS_SENSITIVE_RETENTION_MS - 1000);
    controller.refresh();
    await flush();
    expect(controller.getView().requests).toHaveLength(1);
    expect(controller.getView().dialog).not.toBeNull();
    journal.advanceClock(1000);
    controller.refresh();
    await flush();
    expect(controller.getView().requests).toHaveLength(0);
    expect(controller.getView().dialog).toBeNull();
  });

  it('keeps owner decision and connector readiness apart through the lifecycle', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    controller.decide('approve');
    await flush();
    const outcomes: string[] = [];
    for (const outcome of ['connecting', 'connected'] as const) {
      journal.advance(handle, outcome);
      controller.refresh();
      await flush();
      outcomes.push(controller.getView().requests[0]!.outcome);
    }
    expect(outcomes).toEqual(['connecting', 'connected']);
    expect(controller.getView().requests[0]!.ownerDecision).toBe('approved');
  });

  it('keeps the indicator exact from 0 through 50', async () => {
    const { journal, controller } = setup();
    await flush();
    expect(pendingIndicator(controller.getView().requests)).toBe(0);
    for (let index = 1; index <= 50; index += 1) journal.submit({ ...ACCESS, fingerprint: `agent-${index}` });
    await flush();
    expect(pendingIndicator(controller.getView().requests)).toBe(50);
    expect(fixtureDigest('x')).toHaveLength(43);
  });

  it('an inbox read started before a decision cannot undo it', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    // Hold the next inbox read open with the pre-decision snapshot.
    const inbox = journal.port.inbox.bind(journal.port);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    journal.port.inbox = async () => {
      const stale = await inbox();
      journal.port.inbox = inbox;
      await gate;
      return stale;
    };
    controller.refresh();
    await flush();
    controller.open(handle);
    controller.decide('approve');
    await flush();
    release();
    await flush();
    const row = controller.getView().requests.find(request => request.requestHandle === handle)!;
    expect(row.ownerDecision).toBe('approved');
    expect(controller.getView().dialog!.status.kind).toBe('decided');
  });

  it('closing mid-submit and deciding another request keeps both results', async () => {
    const { journal, controller } = setup();
    const first = journal.submit(ACCESS)!;
    const second = journal.submit(SECOND)!;
    await flush();
    const decide = journal.port.decide.bind(journal.port);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    journal.port.decide = async (input, options) => {
      if (input.requestHandle === first) await gate;
      return decide(input, options);
    };
    controller.open(first);
    controller.decide('approve');
    controller.close();
    // Reopening while the decision is out shows it in flight and offers no second one.
    controller.open(first);
    expect(controller.getView().dialog!.status.kind).toBe('submitting');
    controller.decide('deny');
    controller.close();
    controller.open(second);
    controller.decide('deny');
    await flush();
    release();
    await flush();
    const outcome = (handle: string) => controller.getView().requests.find(request => request.requestHandle === handle)!.ownerDecision;
    expect(outcome(first)).toBe('approved');
    expect(outcome(second)).toBe('denied');
    expect(controller.getView().dialog?.handle).toBe(second);
  });

  it('holds decisions off while a stale request reloads', async () => {
    const journal = createFakeJournal();
    const { controller, decideCalls } = setup(journal);
    const handle = journal.submit(ACCESS)!;
    await flush();
    const inbox = journal.port.inbox.bind(journal.port);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    controller.open(handle);
    journal.bumpRevision(handle);
    journal.port.inbox = async () => {
      await gate;
      return inbox();
    };
    controller.decide('approve');
    await flush();
    expect(controller.getView().dialog!.status.kind).toBe('reloading');
    controller.decide('approve');
    expect(decideCalls).toHaveLength(1);
    release();
    await flush();
    expect(controller.getView().dialog!.status.kind).toBe('refreshed');
    expect(controller.getView().dialog!.request.revision).toBe('carev_2');
  });

  it('orders journal carev_ notification revisions numerically', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    const publish = (revision: string) => (
      { v: 1, notificationId: 'n-order', revision, ownerId: 'owner-a', kind: 'request', requestHandle: handle, count: 1 }
    );
    const subscribers: Array<(notification: unknown) => void> = [];
    const second = createChannelAccessInboxController({ requests: { ...journal.port, subscribe: listener => { subscribers.push(listener); return () => {}; } } }, { now: () => journal.now() });
    second.start();
    await flush();
    subscribers[0]!(publish('carev_10'));
    await flush();
    subscribers[0]!(publish('carev_9'));
    await flush();
    expect(second.getView().notices.find(notice => notice.notificationId === 'n-order')!.revision).toBe('carev_10');
    second.dismissNotice('n-order');
    subscribers[0]!(publish('carev_10'));
    subscribers[0]!(publish('carev_2'));
    await flush();
    expect(second.getView().notices.some(notice => notice.notificationId === 'n-order')).toBe(false);
    subscribers[0]!(publish('carev_11'));
    await flush();
    expect(second.getView().notices.some(notice => notice.notificationId === 'n-order')).toBe(true);
    controller.dispose();
    second.dispose();
  });

  it('an unknown mute outcome refreshes and never claims nothing changed', async () => {
    const { journal, controller } = setup();
    const access = journal.submit(ACCESS)!;
    await flush();
    journal.failNext.setMute.push('unknown_after_commit');
    controller.toggleMute(access);
    await flush();
    expect(controller.getView().status).toEqual({ kind: 'mute_failed', code: 'unknown' });
    expect(controller.getView().requests[0]!.muted).toBe(true);
  });

  it('keeps an approved-then-connected request until 30 days after its deadline bound', async () => {
    const { journal, controller } = setup();
    const handle = journal.submit(ACCESS)!;
    await flush();
    controller.open(handle);
    controller.decide('approve');
    await flush();
    journal.advance(handle, 'connected');
    journal.advanceClock(CHANNEL_ACCESS_SENSITIVE_RETENTION_MS + 1000);
    controller.refresh();
    await flush();
    expect(controller.getView().requests).toHaveLength(1);
    journal.advanceClock(CHANNEL_ACCESS_REQUEST_LIFETIME_MS);
    controller.refresh();
    await flush();
    expect(controller.getView().requests).toHaveLength(0);
  });

  it('stops listening after dispose', async () => {
    const { journal, controller } = setup();
    await flush();
    controller.dispose();
    journal.submit(ACCESS);
    await flush();
    expect(controller.getView().notices).toHaveLength(0);
  });
});
