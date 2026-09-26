import { describe, expect, it } from 'vitest';
import {
  type ApprovalCommand, type BindingId, type CommandId, type DeliveryLimits, type EventRef, decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import type {
  ChannelSnapshot, DeviceId, EventId, OwnerId, ParticipantId, RoomId, RoomPort, TimelineItem,
} from '@khala/contracts/messaging/index';
import type { HumanRouteContext } from '../human/application';
import { registerHumanCapabilities } from '../human/capabilities';
import { createBrowserReviewPort, type ReviewControlClient, type ReviewPreviewRequest } from './browser-port';
import { registerReview } from './register';

const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decoded.ok) throw new Error('limits');
const limits: DeliveryLimits = decoded.value;

const roomId = 'room_review' as RoomId;
const bindingId = 'binding_b' as BindingId;
const viewer = 'owner_b' as OwnerId;
const digest = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

function item(eventId: string, body: string, n: number): TimelineItem {
  return {
    ref: {
      v: 1, roomId, eventId: eventId as EventId, authorParticipantId: 'participant_a' as ParticipantId,
      authorDeviceId: 'device_a' as DeviceId, contentDigest: digest(n),
    },
    content: { v: 1, kind: 'text', body },
    participant: {
      participantId: 'participant_a' as ParticipantId, kind: 'agent', ownerId: 'owner_a' as OwnerId,
      displayName: 'Agent A', deviceIds: [],
    },
    clientTxnId: null,
    receivedAt: '2026-09-25T10:00:00Z',
  } as TimelineItem;
}

const itemA = item('event_a', 'canary A', 1);
const itemB = item('event_b', 'canary B', 2);
const refOf = (value: TimelineItem) => value.ref as EventRef;

function fakeRoom() {
  let listener: ((snapshot: ChannelSnapshot) => void) | null = null;
  const room = {
    observe(_roomId: RoomId, next: (snapshot: ChannelSnapshot) => void) {
      listener = next;
      return () => { listener = null; };
    },
  } as unknown as RoomPort;
  return {
    room,
    emit(items: readonly TimelineItem[], generation = 1) {
      listener?.({
        room: { roomId, title: null, membership: 'joined', revision: `r${generation}` },
        items, snapshotRevision: `s${generation}`, generation,
      });
    },
    observed: () => listener !== null,
  };
}

function previewBody(pending: readonly EventRef[], extra: Record<string, unknown> = {}) {
  return { v: 1, bindingId, bindingGeneration: 0, policyVersion: 3, pending, receipts: [], ...extra };
}

type Answer = Awaited<ReturnType<ReviewControlClient['preview']>>;

function scriptedClient(answer: (request: ReviewPreviewRequest) => Answer | Promise<Answer>) {
  const requests: ReviewPreviewRequest[] = [];
  const commands: ApprovalCommand[] = [];
  let approval: () => Promise<Awaited<ReturnType<ReviewControlClient['approve']>>> =
    async () => ({ kind: 'answered', body: { ok: true, releaseIds: ['release_1'] } });
  const client: ReviewControlClient = {
    async preview(request) {
      requests.push(request);
      return answer(request);
    },
    approve(command) {
      commands.push(command);
      return approval();
    },
  };
  return { client, requests, commands, setApproval: (next: typeof approval) => { approval = next; } };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function command(commandId: string): ApprovalCommand {
  return {
    v: 1, commandId: commandId as CommandId, roomId, bindingId, expectedPolicyVersion: 3,
    expectedBindingGeneration: 0, selection: [refOf(itemB)], issuedAt: '2026-09-25T10:01:00Z',
  };
}

function port(client: ReviewControlClient, room: RoomPort) {
  return createBrowserReviewPort({ client, room, roomId, bindingId, viewerOwnerId: viewer, limits, refreshMs: 0 });
}

describe('browser review port', () => {
  it('sends only exact references, never bodies or owner identity, and shows only digest-exact pending items', async () => {
    const edited = { ...refOf(itemA), contentDigest: digest(99) };
    const { client, requests } = scriptedClient(() => ({ kind: 'ok', body: previewBody([edited, refOf(itemB)]) }));
    const { room, emit } = fakeRoom();
    const review = port(client, room);

    emit([itemA, itemB]);
    await tick();

    expect(Object.keys(requests[0]!).sort()).toEqual(['bindingId', 'candidates', 'releaseIds']);
    expect(JSON.stringify(requests[0])).not.toContain('canary');
    expect(JSON.stringify(requests[0])).not.toContain(viewer);
    expect(review.snapshot()).toMatchObject({ access: 'ready', bindingGeneration: 0, policyVersion: 3 });
    expect(review.snapshot().pending).toEqual([itemB]);
    review.dispose();
  });

  it('never reads a preview answered for another binding or with smuggled fields', async () => {
    const { room, emit } = fakeRoom();
    const forged = scriptedClient(() => ({ kind: 'ok', body: previewBody([refOf(itemB)], { bindingId: 'binding_x' }) }));
    const review = port(forged.client, room);
    emit([itemB]);
    await tick();
    expect(review.snapshot()).toMatchObject({ access: 'unavailable', pending: [] });
    review.dispose();

    const smuggled = scriptedClient(() => ({ kind: 'ok', body: previewBody([refOf(itemB)], { ownerId: viewer }) }));
    const second = port(smuggled.client, room);
    emit([itemB]);
    await tick();
    expect(second.snapshot()).toMatchObject({ access: 'unavailable', pending: [] });
    second.dispose();
  });

  it('replaces the queue on reconnect and drops a late answer from the old generation', async () => {
    let releaseOld!: (answer: Answer) => void;
    const answers: Array<Promise<Answer> | Answer> = [
      new Promise<Answer>(resolve => { releaseOld = resolve; }),
      { kind: 'ok', body: previewBody([refOf(itemB)]) },
    ];
    const { client } = scriptedClient(() => answers.shift()!);
    const { room, emit } = fakeRoom();
    const review = port(client, room);

    emit([itemA, itemB], 1);
    emit([itemB], 2);
    await tick();
    releaseOld({ kind: 'ok', body: previewBody([refOf(itemA), refOf(itemB)]) });
    await tick();

    expect(review.snapshot().pending).toEqual([itemB]);
    emit([itemA, itemB], 1);
    await tick();
    expect(review.snapshot().pending).toEqual([itemB]);
    review.dispose();
  });

  it('keeps approval JSON inside a message body inert', async () => {
    const body = JSON.stringify(command('from-message'));
    const hostile = item('event_c', body, 3);
    const { client, requests, commands } = scriptedClient(() => ({ kind: 'ok', body: previewBody([refOf(hostile)]) }));
    const { room, emit } = fakeRoom();
    const review = port(client, room);

    emit([hostile]);
    await tick();

    expect(commands).toEqual([]);
    expect(JSON.stringify(requests)).not.toContain('from-message');
    expect(review.snapshot().pending).toEqual([hostile]);
    review.dispose();
  });

  it('clears the protected preview on revocation and reports other refusals as unavailable', async () => {
    const answers: Answer[] = [
      { kind: 'ok', body: previewBody([refOf(itemB)]) },
      { kind: 'refused', code: 'revoked' },
      { kind: 'lost' },
    ];
    const { client } = scriptedClient(() => answers.shift()!);
    const { room, emit } = fakeRoom();
    const review = port(client, room);

    emit([itemB]);
    await tick();
    expect(review.snapshot().pending).toEqual([itemB]);
    emit([itemB]);
    await tick();
    expect(review.snapshot()).toMatchObject({ access: 'revoked', pending: [] });
    emit([itemB]);
    await tick();
    expect(review.snapshot().access).toBe('unavailable');
    review.dispose();
  });

  it('maps approval answers without inventing success and asks for receipts of accepted releases', async () => {
    const { client, requests, setApproval } = scriptedClient(() => ({ kind: 'ok', body: previewBody([]) }));
    const { room, emit } = fakeRoom();
    const review = port(client, room);
    emit([itemB]);
    await tick();
    const signal = new AbortController().signal;

    expect(await review.approve(command('c1'), signal)).toEqual({ kind: 'accepted', releaseIds: ['release_1'] });
    await tick();
    expect(requests.at(-1)!.releaseIds).toEqual(['release_1']);

    setApproval(async () => ({ kind: 'answered', body: { ok: false, code: 'stale_policy' } }));
    expect(await review.approve(command('c2'), signal)).toEqual({ kind: 'rejected', code: 'stale_policy' });
    setApproval(async () => ({ kind: 'answered', body: { ok: false, code: 'outcome_unknown', operationId: 'op-9' } }));
    expect(await review.approve(command('c3'), signal)).toEqual({ kind: 'outcome_unknown', commandId: 'c3' });
    setApproval(async () => ({ kind: 'lost' }));
    expect(await review.approve(command('c4'), signal)).toEqual({ kind: 'outcome_unknown', commandId: 'c4' });
    setApproval(async () => ({ kind: 'answered', body: { ok: true, releaseIds: [] } }));
    expect(await review.approve(command('c5'), signal)).toEqual({ kind: 'outcome_unknown', commandId: 'c5' });
    review.dispose();
  });

  it('closing the wait does not cancel the write and keeps the same command identity', async () => {
    let finish!: () => void;
    const { client, commands, setApproval } = scriptedClient(() => ({ kind: 'ok', body: previewBody([]) }));
    setApproval(() => new Promise(resolve => {
      finish = () => resolve({ kind: 'answered', body: { ok: true, releaseIds: ['release_7'] } });
    }));
    const { room } = fakeRoom();
    const review = port(client, room);
    const waiting = new AbortController();

    const pending = review.approve(command('c-wait'), waiting.signal);
    waiting.abort();

    expect(await pending).toEqual({ kind: 'outcome_unknown', commandId: 'c-wait' });
    expect(commands.map(sent => sent.commandId)).toEqual(['c-wait']);
    finish();
    review.dispose();
  });

  it('releases subscriptions on abort and stops observing the room on dispose', () => {
    const { client } = scriptedClient(() => ({ kind: 'ok', body: previewBody([]) }));
    const { room, observed } = fakeRoom();
    const review = port(client, room);
    const controller = new AbortController();
    let calls = 0;
    review.subscribe(() => { calls += 1; }, controller.signal);
    controller.abort();

    review.dispose();
    expect(observed()).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('browser review registration', () => {
  const context = {
    room: fakeRoom().room,
    principal: { ownerId: viewer },
  } as unknown as HumanRouteContext;

  it('keeps the production slot unavailable until the protected transport is supplied', () => {
    const review = registerHumanCapabilities().find(capability => capability.id === 'review');
    expect(review?.state).toBe('unavailable');
    expect(registerReview().portFor(context, roomId)).toBeNull();
  });

  it('scopes ports to an attached route and disposes them with it', () => {
    const { client } = scriptedClient(() => ({ kind: 'ok', body: previewBody([]) }));
    const capability = registerReview({ client, limits, refreshMs: 0, bindingFor: () => bindingId });

    expect(capability.state).toBe('ready');
    expect(capability.portFor(context, roomId)).toBeNull();
    const attachment = capability.attach(context);
    const review = capability.portFor(context, roomId);
    expect(review?.snapshot()).toMatchObject({ access: 'loading', viewerOwnerId: viewer });

    attachment.dispose();
    expect(capability.portFor(context, roomId)).toBeNull();
    const none = registerReview({ client, limits, bindingFor: () => null });
    none.attach(context);
    expect(none.portFor(context, roomId)).toBeNull();
  });
});
