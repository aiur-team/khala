import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import {
  type DeviceId, type EventId, type MessageContent, type OwnerId, type ParticipantId, type RoomId,
} from '@khala/contracts/messaging/index';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelStore, type ChannelStore, type RegisteredParticipant } from './channel-store';
import { encodeSubscriptionCursor, encodeTimelineCursor } from './cursors';
import { openChannelStore, type InternalStoreHandle } from './open';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const alice: RegisteredParticipant = {
  participantId: 'participant-alice' as ParticipantId,
  ownerId: 'owner-alice' as OwnerId,
  kind: 'human',
  displayName: 'Alice',
};
const bob: RegisteredParticipant = {
  participantId: 'participant-bob' as ParticipantId,
  ownerId: 'owner-bob' as OwnerId,
  kind: 'agent',
  displayName: 'Bob',
};
const aliceDevice = 'device-alice' as DeviceId;
const bobDevice = 'device-bob' as DeviceId;
const channelId = 'channel-one' as RoomId;
const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });

const bobBinding: SessionBinding = {
  v: 1,
  bindingId: 'binding-bob' as SessionBinding['bindingId'],
  ownerId: bob.ownerId,
  agentParticipantId: bob.participantId,
  deviceId: bobDevice,
  harness: 'codex',
  sessionId: 'session-bob',
  generation: 4,
};

function fresh(): Readonly<{ directory: string; handle: InternalStoreHandle; store: ChannelStore }> {
  const root = fs.mkdtempSync('/tmp/khala-channel-store-');
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'state');
  const handle = openChannelStore({ directory, mode: 'create' });
  handles.push(handle);
  return { directory, handle, store: createChannelStore(handle) };
}

function seed(store: ChannelStore): void {
  expect(store.registerParticipant(alice)).toMatchObject({ kind: 'done' });
  expect(store.registerParticipant(bob)).toMatchObject({ kind: 'done' });
  expect(store.registerDevice({ deviceId: aliceDevice, participantId: alice.participantId })).toMatchObject({ kind: 'done' });
  expect(store.registerDevice({ deviceId: bobDevice, participantId: bob.participantId })).toMatchObject({ kind: 'done' });
  expect(store.registerBinding(bobBinding)).toMatchObject({ kind: 'done' });
  expect(store.createChannel({
    operationId: 'create-one', channelId, title: 'One', creatorOwnerId: alice.ownerId, creatorParticipantId: alice.participantId,
    creatorDeviceId: aliceDevice, createdAt: '2026-09-24T20:00:00.000Z',
  })).toMatchObject({ kind: 'created', channel: { channelId, membership: 'joined', revision: '0' } });
  expect(store.setMembership({ channelId, participantId: bob.participantId, membership: 'joined' }))
    .toMatchObject({ kind: 'done' });
}

function send(store: ChannelStore, input: Readonly<{
  eventId: string;
  author?: 'alice' | 'bob';
  transaction?: string;
  body?: string;
  receivedAt?: string;
}>) {
  const author = input.author === 'bob'
    ? { participantId: bob.participantId, deviceId: bobDevice }
    : { participantId: alice.participantId, deviceId: aliceDevice };
  return store.send({
    channelId,
    eventId: input.eventId as EventId,
    authorParticipantId: author.participantId,
    authorDeviceId: author.deviceId,
    clientTxnId: input.transaction ?? `txn-${input.eventId}`,
    content: text(input.body ?? input.eventId),
    receivedAt: input.receivedAt ?? `2026-09-24T20:00:${input.eventId.padStart(2, '0')}.000Z`,
  });
}

describe('channel store identity and authority', () => {
  it('persists roster, immutable device ownership and exact binding history across restart', () => {
    const { directory, handle, store } = fresh();
    seed(store);
    expect(send(store, { eventId: '1', author: 'bob', body: 'before restart' })).toMatchObject({ kind: 'stored' });
    expect(store.registerDevice({ deviceId: aliceDevice, participantId: bob.participantId }))
      .toEqual({ kind: 'rejected', code: 'identity_mismatch' });
    expect(store.registerBinding({ ...bobBinding, sessionId: 'substitute' }))
      .toEqual({ kind: 'rejected', code: 'identity_mismatch' });
    const nextBinding = { ...bobBinding, generation: 5, sessionId: 'session-bob-next' };
    expect(store.registerBinding(nextBinding)).toEqual({ kind: 'done', changed: true });
    expect(store.revokeBinding({ bindingId: bobBinding.bindingId, generation: bobBinding.generation }))
      .toEqual({ kind: 'done', changed: true });
    handle.close();

    const reopened = openChannelStore({ directory, mode: 'existing' });
    handles.push(reopened);
    const again = createChannelStore(reopened);
    expect(again.roster(channelId)).toMatchObject({
      kind: 'done',
      participants: [
        { participantId: alice.participantId, deviceIds: [aliceDevice] },
        { participantId: bob.participantId, deviceIds: [bobDevice] },
      ],
    });
    expect(again.binding(bobBinding)).toMatchObject({ kind: 'done', binding: { status: 'revoked' } });
    expect(again.binding(nextBinding)).toMatchObject({ kind: 'done', binding: { status: 'active', generation: 5 } });
    expect(again.timeline({ channelId, participantId: alice.participantId, cursor: null, limit: 10 }))
      .toMatchObject({
        kind: 'done',
        events: [{
          eventId: '1', authorParticipantId: bob.participantId, authorDeviceId: bobDevice,
          content: { body: 'before restart' },
        }],
      });
  });
});

describe('channel creation and sends', () => {
  it('replays one global channel operation only for its exact trusted creator and title', () => {
    const { store } = fresh();
    seed(store);
    expect(store.createChannel({
      operationId: 'create-one', channelId: 'ignored-on-retry' as RoomId, title: 'One',
      creatorOwnerId: alice.ownerId, creatorParticipantId: alice.participantId,
      creatorDeviceId: aliceDevice, createdAt: '2099-01-01T00:00:00.000Z',
    })).toMatchObject({ kind: 'replayed', channel: { channelId } });
    expect(store.createChannel({
      operationId: 'create-one', channelId: 'other' as RoomId, title: 'Changed',
      creatorOwnerId: alice.ownerId, creatorParticipantId: alice.participantId,
      creatorDeviceId: aliceDevice, createdAt: '2026-09-24T20:00:00.000Z',
    })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(store.createChannel({
      operationId: 'create-one', channelId: 'other' as RoomId, title: 'One',
      creatorOwnerId: 'owner-substitute' as OwnerId, creatorParticipantId: alice.participantId,
      creatorDeviceId: aliceDevice, createdAt: '2026-09-24T20:00:00.000Z',
    })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(store.createChannel({
      operationId: 'create-one', channelId: 'other' as RoomId, title: 'One',
      creatorOwnerId: bob.ownerId, creatorParticipantId: bob.participantId,
      creatorDeviceId: bobDevice, createdAt: '2026-09-24T20:00:00.000Z',
    })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(store.findCreatedChannel({
      operationId: 'create-one', creatorOwnerId: alice.ownerId,
      creatorParticipantId: alice.participantId, creatorDeviceId: aliceDevice,
    })).toMatchObject({ kind: 'found', channel: { channelId } });
    expect(store.findCreatedChannel({
      operationId: 'create-one', creatorOwnerId: bob.ownerId,
      creatorParticipantId: alice.participantId, creatorDeviceId: aliceDevice,
    })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(store.findCreatedChannel({
      operationId: 'absent', creatorOwnerId: alice.ownerId,
      creatorParticipantId: alice.participantId, creatorDeviceId: aliceDevice,
    })).toEqual({ kind: 'absent' });
    expect(store.participantForDevice({ channelId, deviceId: bobDevice }))
      .toEqual({ kind: 'done', participantId: bob.participantId });
  });

  it('deduplicates exact device transaction retries and rejects changed reuse', () => {
    const { handle, store } = fresh();
    seed(store);
    const notifications: string[] = [];
    handle.subscribe(notification => notifications.push(notification.kind));
    const input = {
      channelId, eventId: 'event-one' as Parameters<ChannelStore['send']>[0]['eventId'],
      authorParticipantId: alice.participantId, authorDeviceId: aliceDevice,
      clientTxnId: 'same-txn', content: text('hello'), receivedAt: '2026-09-24T20:00:01.000Z',
    };
    const first = store.send(input);
    const retry = store.send({ ...input, eventId: 'event-two' as typeof input.eventId });
    expect([first.kind, retry.kind].sort()).toEqual(['replayed', 'stored']);
    expect(retry).toMatchObject({ event: { eventId: 'event-one', receivedAt: input.receivedAt } });
    expect(notifications).toEqual(['channel', 'subscription']);
    expect(handle.read(db => (db.prepare('SELECT count(*) AS value FROM events').get() as { value: number }).value)).toBe(1);
    expect(store.send({ ...input, channelId: 'other' as RoomId })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(store.send({ ...input, authorParticipantId: bob.participantId }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(store.send({ ...input, content: text('changed') })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
  });

  it('publishes committed full channel updates before content-free hints and isolates listeners', () => {
    const { store } = fresh();
    seed(store);
    const observed: string[] = [];
    const stopFailing = store.subscribeChannel({ channelId, participantId: alice.participantId }, update => {
      observed.push(`channel:${update.events.at(-1)?.content.body}`);
      throw new Error('listener failure');
    });
    const stopHealthy = store.subscribeChannel(
      { channelId, participantId: bob.participantId },
      update => observed.push(`healthy:${update.events.length}`),
    );
    const stopHint = store.subscribeHints(channelId, () => observed.push('hint'));
    expect(send(store, { eventId: '1', body: 'committed' })).toMatchObject({ kind: 'stored' });
    expect(observed).toEqual(['channel:committed', 'healthy:1', 'hint']);
    expect(send(store, { eventId: '2', transaction: 'txn-1', body: 'changed' }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(observed).toEqual(['channel:committed', 'healthy:1', 'hint']);
    stopFailing();
    stopHealthy();
    expect(send(store, { eventId: '2', body: 'after channel disposal' })).toMatchObject({ kind: 'stored' });
    expect(observed).toEqual(['channel:committed', 'healthy:1', 'hint', 'hint']);
    stopHint();
    expect(send(store, { eventId: '3', body: 'after all disposal' })).toMatchObject({ kind: 'stored' });
    expect(observed).toEqual(['channel:committed', 'healthy:1', 'hint', 'hint']);
  });

  it('round-trips injection-shaped trusted values only as bound data', () => {
    const { store } = fresh();
    const shaped = {
      participantId: "participant-'); DROP TABLE events; --" as ParticipantId,
      ownerId: "owner-' OR 1=1 --" as OwnerId,
      kind: 'human' as const,
      displayName: "Robert'); DROP TABLE participants; --",
    };
    const shapedDevice = "device-'); DELETE FROM channels; --" as DeviceId;
    expect(store.registerParticipant(shaped)).toEqual({ kind: 'done', changed: true });
    expect(store.registerDevice({ deviceId: shapedDevice, participantId: shaped.participantId }))
      .toEqual({ kind: 'done', changed: true });
    expect(store.createChannel({
      operationId: "operation-' OR 1=1 --",
      channelId: "channel-'); DROP TABLE bindings; --" as RoomId,
      title: "A title'); DROP TABLE devices; --",
      creatorOwnerId: shaped.ownerId,
      creatorParticipantId: shaped.participantId,
      creatorDeviceId: shapedDevice,
      createdAt: '2026-09-24T20:00:00.000Z',
    })).toMatchObject({
      kind: 'created',
      channel: { title: "A title'); DROP TABLE devices; --" },
    });
    expect(store.registerParticipant(alice)).toEqual({ kind: 'done', changed: true });
  });

  it('fails closed when persisted canonical bytes are no longer strict or digest-valid', () => {
    const { handle, store } = fresh();
    seed(store);
    expect(send(store, { eventId: '1', body: 'valid' })).toMatchObject({ kind: 'stored' });
    const noncanonical = Buffer.from(` [\"khala.message.v1\",\"text\",\"valid\"]`, 'utf8');
    handle.transaction(db => {
      db.prepare("UPDATE events SET canonical_payload = ?, content_digest = ? WHERE event_id = '1'")
        .run(noncanonical, `sha256:${createHash('sha256').update(noncanonical).digest('hex')}`);
    });
    expect(store.timeline({ channelId, participantId: alice.participantId, cursor: null, limit: 10 }))
      .toEqual({ kind: 'unavailable' });
  });
});

describe('timeline and subscription replay', () => {
  it('keeps an older timeline cursor on its original high-water while returning chronological pages', () => {
    const { store } = fresh();
    seed(store);
    send(store, { eventId: '1' });
    send(store, { eventId: '2' });
    const newest = store.timeline({ channelId, participantId: alice.participantId, cursor: null, limit: 1 });
    expect(newest).toMatchObject({ kind: 'done', events: [{ eventId: '2' }] });
    if (newest.kind !== 'done') throw new Error('expected page');
    send(store, { eventId: '3' });
    expect(store.timeline({ channelId, participantId: alice.participantId, cursor: newest.nextCursor, limit: 2 }))
      .toMatchObject({ kind: 'done', events: [{ eventId: '1' }], nextCursor: null, revision: newest.revision });
    expect(store.timeline({ channelId, participantId: alice.participantId, cursor: null, limit: 2 }))
      .toMatchObject({ kind: 'done', events: [{ eventId: '2' }, { eventId: '3' }] });
  });

  it('refuses malformed, cross-channel and future timeline cursors', () => {
    const { store } = fresh();
    seed(store);
    send(store, { eventId: '1' });
    for (const cursor of [
      'not-a-cursor',
      encodeTimelineCursor({ channelId: 'other' as RoomId, snapshotHighWater: 1, snapshotRevision: 1, beforeSequence: 1 }),
      encodeTimelineCursor({ channelId, snapshotHighWater: 99, snapshotRevision: 99, beforeSequence: 99 }),
    ]) {
      expect(store.timeline({ channelId, participantId: alice.participantId, cursor, limit: 10 }))
        .toEqual({ kind: 'rejected', code: 'invalid_cursor' });
    }
  });

  it('advances over a self row without consuming its peer lookahead', () => {
    const { store } = fresh();
    seed(store);
    send(store, { eventId: '1', author: 'bob' });
    send(store, { eventId: '2', author: 'alice' });
    const first = store.readSubscription({ channelId, binding: bobBinding, cursor: null, limit: 1 });
    expect(first).toMatchObject({ kind: 'page', events: [], caughtUp: false });
    if (first.kind !== 'page') throw new Error('expected page');
    const second = store.readSubscription({ channelId, binding: bobBinding, cursor: first.nextCursor, limit: 1 });
    expect(second).toMatchObject({ kind: 'page', events: [{ eventId: '2' }], caughtUp: true });
    expect(store.readSubscription({ channelId, binding: bobBinding, cursor: first.nextCursor, limit: 1 })).toEqual(second);
  });

  it('never returns or skips an all-peer lookahead row', () => {
    const { store } = fresh();
    seed(store);
    send(store, { eventId: '1', author: 'alice' });
    send(store, { eventId: '2', author: 'alice' });
    const first = store.readSubscription({ channelId, binding: bobBinding, cursor: null, limit: 1 });
    expect(first).toMatchObject({ kind: 'page', events: [{ eventId: '1' }], caughtUp: false });
    if (first.kind !== 'page') throw new Error('expected page');
    expect(store.readSubscription({ channelId, binding: bobBinding, cursor: first.nextCursor, limit: 1 }))
      .toMatchObject({ kind: 'page', events: [{ eventId: '2' }], caughtUp: true });
  });

  it('binds subscription cursors to the exact channel, binding and generation', () => {
    const { store } = fresh();
    seed(store);
    const wrong = encodeSubscriptionCursor({
      channelId, bindingId: 'different', generation: bobBinding.generation, lastCoveredSequence: 0,
    });
    expect(store.readSubscription({ channelId, binding: bobBinding, cursor: wrong, limit: 1 }))
      .toEqual({ kind: 'rejected', code: 'invalid_cursor' });
    expect(store.readSubscription({ channelId, binding: { ...bobBinding, generation: 9 }, cursor: null, limit: 1 }))
      .toEqual({ kind: 'rejected', code: 'stale_binding' });
    for (const cursor of [
      'malformed',
      encodeSubscriptionCursor({
        channelId: 'other' as RoomId, bindingId: bobBinding.bindingId,
        generation: bobBinding.generation, lastCoveredSequence: 0,
      }),
      encodeSubscriptionCursor({
        channelId, bindingId: bobBinding.bindingId,
        generation: bobBinding.generation, lastCoveredSequence: 99,
      }),
    ]) {
      expect(store.readSubscription({ channelId, binding: bobBinding, cursor, limit: 1 }))
        .toEqual({ kind: 'rejected', code: 'invalid_cursor' });
    }
  });
});
