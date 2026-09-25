import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceId, EventId, MessageContent, OwnerId, ParticipantId, ParticipantView, RoomId,
} from '@khala/contracts/messaging/index';
import type {
  ChannelSubstrate, SubstrateEvent, SubstrateUpdate,
} from '@khala/messaging/channels/substrate';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelStore, type ChannelStore } from '../../store/channel-store';
import { openChannelStore, type InternalStoreHandle } from '../../store/open';
import { createLocalChannelSubstrate } from './channel-substrate';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const alice: ParticipantView = {
  participantId: 'participant-alice' as ParticipantId,
  ownerId: 'owner-alice' as OwnerId,
  kind: 'human',
  displayName: 'Alice',
  deviceIds: ['device-alice' as DeviceId],
};
const bob: ParticipantView = {
  participantId: 'participant-bob' as ParticipantId,
  ownerId: 'owner-bob' as OwnerId,
  kind: 'agent',
  displayName: 'Bob',
  deviceIds: ['device-bob' as DeviceId],
};
const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });

function fresh(): ChannelStore {
  const root = fs.mkdtempSync('/tmp/khala-channel-substrate-');
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const handle = openChannelStore({ directory: path.join(root, 'state'), mode: 'create' });
  handles.push(handle);
  const store = createChannelStore(handle);
  for (const participant of [alice, bob]) {
    expect(store.registerParticipant(participant)).toMatchObject({ kind: 'done' });
    expect(store.registerDevice({ deviceId: participant.deviceIds[0]!, participantId: participant.participantId }))
      .toMatchObject({ kind: 'done' });
  }
  return store;
}

function substrate(
  store: ChannelStore,
  actor: ParticipantView = alice,
  overrides: Partial<Parameters<typeof createLocalChannelSubstrate>[0]> = {},
): ChannelSubstrate {
  let id = 0;
  let time = Date.parse('2026-09-24T20:00:00.000Z');
  return createLocalChannelSubstrate({
    store,
    ownerId: actor.ownerId,
    participant: actor,
    deviceId: actor.deviceIds[0]!,
    generation: 7,
    newId: () => `generated-${++id}`,
    clock: () => time++,
    ...overrides,
  });
}

async function createOne(store: ChannelStore, local = substrate(store)) {
  const created = await local.createRoom({ operationId: 'create-one', title: 'One' });
  expect(created).toMatchObject({ kind: 'done', value: { roomId: 'generated-1', title: 'One', membership: 'joined' } });
  return { local, roomId: (created as Extract<typeof created, { kind: 'done' }>).value.roomId };
}

describe('local channel substrate', () => {
  it('maps every channel call and immutable stored event field through the public contract', async () => {
    const store = fresh();
    const { local, roomId } = await createOne(store);

    expect(await local.findCreatedRoom({ operationId: 'create-one' }))
      .toMatchObject({ kind: 'found', room: { roomId, revision: '0' } });
    expect(await local.findCreatedRoom({ operationId: 'absent' })).toEqual({ kind: 'absent' });
    expect(await local.room(roomId)).toMatchObject({ kind: 'done', value: { roomId, title: 'One' } });

    const sent = await local.sendEvent({ roomId, clientTxnId: 'txn-one', content: text('hello') });
    expect(sent).toEqual({ kind: 'done', value: { eventId: 'generated-2', authorDeviceId: alice.deviceIds[0] } });
    const page = await local.timeline({ roomId, cursor: null, limit: 10 });
    expect(page).toMatchObject({
      kind: 'done',
      value: {
        revision: '1',
        nextCursor: null,
        events: [{
          kind: 'message',
          eventId: 'generated-2' as EventId,
          authorDeviceId: alice.deviceIds[0]!,
          participant: alice,
          content: text('hello'),
          clientTxnId: 'txn-one',
          receivedAt: '2026-09-24T20:00:00.001Z',
        } satisfies SubstrateEvent],
      },
    });
  });

  it('uses only trusted construction identity and maps actor and membership refusals', async () => {
    const store = fresh();
    const forged = substrate(store, alice, { ownerId: bob.ownerId });
    expect(await forged.createRoom({ operationId: 'forged', title: null }))
      .toEqual({ kind: 'rejected', code: 'forbidden' });

    const { roomId } = await createOne(store);
    const outsider = substrate(store, bob);
    expect(await outsider.room(roomId)).toEqual({ kind: 'rejected', code: 'not_joined' });
    expect(await outsider.timeline({ roomId, cursor: null, limit: 10 }))
      .toEqual({ kind: 'rejected', code: 'not_joined' });
    expect(await outsider.sendEvent({ roomId, clientTxnId: 'outside', content: text('no') }))
      .toEqual({ kind: 'rejected', code: 'not_joined' });
  });

  it('replays exact creates and sends while rejecting changed operation reuse', async () => {
    const store = fresh();
    const local = substrate(store);
    const first = await local.createRoom({ operationId: 'create-one', title: 'One' });
    const retry = await local.createRoom({ operationId: 'create-one', title: 'One' });
    expect(retry).toEqual(first);
    expect(await local.createRoom({ operationId: 'create-one', title: 'Changed' }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    const roomId = (first as Extract<typeof first, { kind: 'done' }>).value.roomId;

    const accepted = await local.sendEvent({ roomId, clientTxnId: 'txn-one', content: text('hello') });
    expect(await local.sendEvent({ roomId, clientTxnId: 'txn-one', content: text('hello') })).toEqual(accepted);
    expect(await local.sendEvent({ roomId, clientTxnId: 'txn-one', content: text('changed') }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
  });

  it('synchronously emits a current full update, post-commit replacements, generation, and disposal', async () => {
    const store = fresh();
    const { local, roomId } = await createOne(store);
    const updates: SubstrateUpdate[] = [];

    const dispose = local.subscribe(roomId, update => updates.push(update));
    expect(updates).toEqual([{
      generation: 7,
      room: { roomId, title: 'One', membership: 'joined', revision: '0' },
      events: [],
    }]);

    await local.sendEvent({ roomId, clientTxnId: 'txn-one', content: text('first') });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      generation: 7,
      room: { revision: '1' },
      events: [{ eventId: 'generated-2', clientTxnId: 'txn-one', receivedAt: '2026-09-24T20:00:00.001Z' }],
    });

    await local.sendEvent({ roomId, clientTxnId: 'txn-one', content: text('first') });
    expect(updates).toHaveLength(2);
    dispose();
    await local.sendEvent({ roomId, clientTxnId: 'txn-two', content: text('second') });
    expect(updates).toHaveLength(2);
  });

  it('maps unavailable effect storage conservatively to unknown and read storage to unavailable', async () => {
    const store = fresh();
    const local = substrate(store);
    handles.splice(0).forEach(handle => handle.close());

    expect(await local.createRoom({ operationId: 'closed', title: null })).toEqual({ kind: 'unknown' });
    expect(await local.sendEvent({ roomId: 'closed' as RoomId, clientTxnId: 'txn', content: text('x') }))
      .toEqual({ kind: 'unknown' });
    expect(await local.room('closed' as RoomId)).toEqual({ kind: 'unavailable' });
    expect(await local.timeline({ roomId: 'closed' as RoomId, cursor: null, limit: 1 }))
      .toEqual({ kind: 'unavailable' });
  });
});
