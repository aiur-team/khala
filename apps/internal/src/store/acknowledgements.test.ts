import fs from 'node:fs';
import path from 'node:path';
import { agentAcknowledgementReceiptId as connectorReceiptId } from '@khala/connector/storage/acknowledgements';
import type { ReleaseId, SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { afterEach, describe, expect, it } from 'vitest';
import { agentAcknowledgementReceiptId, createAgentAcknowledgementLedger } from './acknowledgements';
import { type ChannelStore, type RegisteredParticipant, createChannelStore } from './channel-store';
import { type InternalStoreHandle, openChannelStore } from './open';
import { internalReleaseId } from './release-id';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const alice: RegisteredParticipant = {
  participantId: 'participant-alice' as ParticipantId, ownerId: 'owner-alice' as OwnerId, kind: 'human', displayName: 'Alice',
};
const bob: RegisteredParticipant = {
  participantId: 'participant-bob' as ParticipantId, ownerId: 'owner-bob' as OwnerId, kind: 'agent', displayName: 'Bob',
};
const aliceDevice = 'device-alice' as DeviceId;
const bobDevice = 'device-bob' as DeviceId;
const channelId = 'channel-one' as RoomId;
const binding = (generation: number): SessionBinding => ({
  v: 1, bindingId: 'binding-bob' as SessionBinding['bindingId'], ownerId: bob.ownerId, agentParticipantId: bob.participantId,
  deviceId: bobDevice, harness: 'codex', sessionId: 'session-bob', generation,
});
const PRINCIPAL = { bindingId: 'binding-bob', generation: 4 };

function world() {
  const root = fs.mkdtempSync('/tmp/khala-acknowledgements-');
  roots.push(root);
  const handle = openChannelStore({ directory: path.join(root, 'state'), mode: 'create' });
  handles.push(handle);
  const store = createChannelStore(handle);
  expect(store.registerParticipant(alice)).toMatchObject({ kind: 'done' });
  expect(store.registerParticipant(bob)).toMatchObject({ kind: 'done' });
  expect(store.registerDevice({ deviceId: aliceDevice, participantId: alice.participantId })).toMatchObject({ kind: 'done' });
  expect(store.registerDevice({ deviceId: bobDevice, participantId: bob.participantId })).toMatchObject({ kind: 'done' });
  expect(store.registerBinding(binding(4))).toMatchObject({ kind: 'done' });
  expect(store.createChannel({
    operationId: 'create-one', channelId, title: 'One', creatorOwnerId: alice.ownerId, creatorParticipantId: alice.participantId,
    creatorDeviceId: aliceDevice, createdAt: '2026-09-26T00:00:00.000Z',
  })).toMatchObject({ kind: 'created' });
  expect(store.setMembership({ channelId, participantId: bob.participantId, membership: 'joined' })).toMatchObject({ kind: 'done' });
  let evidence = 0;
  const ledger = createAgentAcknowledgementLedger(handle, {
    now: () => new Date('2026-09-26T10:00:00.000Z'), newEvidenceRef: () => `ack_${++evidence}`,
  });
  return { handle, store, ledger };
}

function send(store: ChannelStore, eventId: string, author: 'alice' | 'bob' = 'alice'): string {
  const who = author === 'bob' ? { participantId: bob.participantId, deviceId: bobDevice } : { participantId: alice.participantId, deviceId: aliceDevice };
  expect(store.send({
    channelId, eventId: eventId as EventId, authorParticipantId: who.participantId, authorDeviceId: who.deviceId,
    clientTxnId: `txn-${eventId}`, content: { v: 1, kind: 'text', body: eventId }, receivedAt: '2026-09-26T09:00:00.000Z',
  })).toMatchObject({ kind: 'stored' });
  return eventId;
}

const release = (eventId: string, principal = PRINCIPAL) => ({ releaseId: internalReleaseId(principal, eventId), eventIds: [eventId] });

describe('internal agent-acknowledgement ledger', () => {
  it('records one receipt per release of the batch, under the connector\'s receipt identity, and pages it by revision', async () => {
    const { store, ledger } = world();
    const events = [send(store, 'e1'), send(store, 'e2')];
    const recorded = ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: events.map(id => release(id)) });
    expect(recorded).toMatchObject({ kind: 'recorded', evidenceRef: 'ack_1' });
    if (recorded.kind !== 'recorded') throw new Error('not recorded');
    expect(recorded.receipts.map(receipt => receipt.receiptId))
      .toEqual(events.map(id => connectorReceiptId(PRINCIPAL as never, internalReleaseId(PRINCIPAL, id) as ReleaseId)));
    expect(recorded.receipts[0]).toEqual({
      v: 2, receiptId: agentAcknowledgementReceiptId(PRINCIPAL, internalReleaseId(PRINCIPAL, 'e1')),
      releaseId: internalReleaseId(PRINCIPAL, 'e1'), bindingId: 'binding-bob', generation: 4, kind: 'agent_acknowledged',
      observedAt: '2026-09-26T10:00:00Z', source: 'agent', evidenceRef: 'ack_1', errorCode: null,
    });
    const outbox = await ledger.readReceiptOutbox();
    expect(outbox.map(entry => [entry.ledgerRevision, entry.events])).toEqual([
      [1, [{ roomId: channelId, eventId: 'e1' }]], [1, [{ roomId: channelId, eventId: 'e2' }]],
    ]);
    expect(await ledger.readReceiptOutbox({ afterRevision: 1 })).toEqual([]);
  });

  it('answers a replayed acknowledgement with the receipts already recorded, and refuses a partial overlap', async () => {
    const { store, ledger } = world();
    const [e1, e2] = [send(store, 'e1'), send(store, 'e2')];
    const first = ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(e1)] });
    const again = ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(e1)] });
    expect(again).toEqual({ ...first, kind: 'duplicate' });
    expect(ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(e1), release(e2)] }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await ledger.readReceiptOutbox()).toHaveLength(1);
  });

  it('records nothing for a release made for another binding generation, an unknown event or the agent\'s own event', async () => {
    const { store, ledger } = world();
    const e1 = send(store, 'e1');
    const own = send(store, 'e-own', 'bob');
    for (const releases of [
      [release(e1, { bindingId: 'binding-bob', generation: 3 })],
      [release(e1, { bindingId: 'binding-other', generation: 4 })],
      [{ releaseId: internalReleaseId(PRINCIPAL, 'e-missing'), eventIds: ['e-missing'] }],
      [{ releaseId: internalReleaseId(PRINCIPAL, e1), eventIds: [e1, e1] }],
      [release(own)],
      [],
    ]) {
      expect(ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases }))
        .toEqual({ kind: 'refused', code: 'invalid_input' });
    }
    expect(await ledger.readReceiptOutbox()).toEqual([]);
  });

  it('refuses a stale, revoked or foreign principal before reading anything', async () => {
    const { store, ledger } = world();
    const e1 = send(store, 'e1');
    const refused = { kind: 'refused', code: 'binding_not_held' };
    expect(ledger.recordBatchAcknowledgement({ principal: { bindingId: 'binding-other', generation: 4 }, channelId, releases: [release(e1)] }))
      .toEqual(refused);
    // A newer generation makes generation 4 stale even though its row is still active.
    expect(store.registerBinding(binding(5))).toMatchObject({ kind: 'done' });
    expect(ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(e1)] })).toEqual(refused);
    const current = { bindingId: 'binding-bob', generation: 5 };
    expect(store.revokeBinding(current)).toMatchObject({ kind: 'done' });
    expect(ledger.recordBatchAcknowledgement({ principal: current, channelId, releases: [release(e1, current)] })).toEqual(refused);
    expect(await ledger.readReceiptOutbox()).toEqual([]);
  });

  it('refuses a channel the binding has not joined', async () => {
    const { store, ledger } = world();
    const e1 = send(store, 'e1');
    expect(store.setMembership({ channelId, participantId: bob.participantId, membership: 'left' })).toMatchObject({ kind: 'done' });
    expect(ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(e1)] }))
      .toEqual({ kind: 'refused', code: 'not_joined' });
  });

  it('never acknowledges an event from before the binding\'s activation start', async () => {
    const { handle, store, ledger } = world();
    const before = send(store, 'e-before');
    handle.transaction(db => db.prepare(`INSERT INTO discovery_activations (operation_key, binding_id, generation, channel_id, session_generation, start_sequence)
      VALUES ('op', 'binding-bob', 4, ?, 1, 1)`).run(channelId));
    const after = send(store, 'e-after');
    expect(ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(before)] }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(ledger.recordBatchAcknowledgement({ principal: PRINCIPAL, channelId, releases: [release(after)] }))
      .toMatchObject({ kind: 'recorded' });
  });
});
