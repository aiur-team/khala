import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import {
  type DeviceId, type EventId, type MessageContent, type OwnerId, type ParticipantId, type ParticipantView, type RoomId,
  encodeMessageContent,
} from '@khala/contracts/messaging/index';
import type { ProvenancePort, SubscriptionSource } from '@khala/connector/subscription/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannelStore, type ChannelStore } from '../../store/channel-store';
import { admitWithSharedHistory } from '../../store/fixtures/admission';
import { openChannelStore, type InternalStoreHandle } from '../../store/open';
import { createLocalSubscriptionSource } from './subscription-source';

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
const channelId = 'channel-one' as RoomId;
const binding: SessionBinding = {
  v: 1,
  bindingId: 'binding-bob' as SessionBinding['bindingId'],
  ownerId: bob.ownerId as SessionBinding['ownerId'],
  agentParticipantId: bob.participantId as SessionBinding['agentParticipantId'],
  deviceId: bob.deviceIds[0] as SessionBinding['deviceId'],
  harness: 'codex',
  sessionId: 'session-bob',
  generation: 4,
};
const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });

function fresh(): ChannelStore {
  const root = fs.mkdtempSync('/tmp/khala-subscription-source-');
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
  expect(store.registerBinding(binding)).toMatchObject({ kind: 'done' });
  expect(store.createChannel({
    operationId: 'create-one',
    channelId,
    title: 'One',
    creatorOwnerId: alice.ownerId,
    creatorParticipantId: alice.participantId,
    creatorDeviceId: alice.deviceIds[0]!,
    createdAt: '2026-09-24T20:00:00.000Z',
  })).toMatchObject({ kind: 'created' });
  expect(store.setMembership({ channelId, participantId: bob.participantId, membership: 'joined' }))
    .toMatchObject({ kind: 'done' });
  admitWithSharedHistory(handle, binding, channelId);
  return store;
}

function transport(
  store: ChannelStore,
  exactBinding: SessionBinding = binding,
): Readonly<{ source: SubscriptionSource; provenance: ProvenancePort }> {
  return createLocalSubscriptionSource({ store, binding: exactBinding, channelId });
}

function send(
  store: ChannelStore,
  sequence: number,
  author: ParticipantView,
  body = `event-${sequence}`,
) {
  return store.send({
    channelId,
    eventId: `event-${sequence}` as EventId,
    authorParticipantId: author.participantId,
    authorDeviceId: author.deviceIds[0]!,
    clientTxnId: `txn-${sequence}`,
    content: text(body),
    receivedAt: `2026-09-24T20:00:${String(sequence).padStart(2, '0')}.000Z`,
  });
}

describe('local subscription source authority', () => {
  it('authorizes only the exact active persisted binding and joined channel on every call', async () => {
    const store = fresh();
    const exact = transport(store).source;
    expect(await exact.authorize()).toBe('ok');

    const mismatches: readonly SessionBinding[] = [
      { ...binding, v: 2 } as unknown as SessionBinding,
      { ...binding, bindingId: 'binding-other' as SessionBinding['bindingId'] },
      { ...binding, ownerId: 'owner-other' as SessionBinding['ownerId'] },
      { ...binding, agentParticipantId: 'participant-other' as SessionBinding['agentParticipantId'] },
      { ...binding, deviceId: 'device-other' as SessionBinding['deviceId'] },
      { ...binding, harness: 'other-harness' },
      { ...binding, sessionId: 'other-session' },
      { ...binding, generation: binding.generation + 1 },
    ];
    for (const mismatch of mismatches) {
      expect(await transport(store, mismatch).source.authorize()).toBe('revoked');
    }

    expect(await createLocalSubscriptionSource({
      store,
      binding: { ...binding, bindingId: 'missing' as SessionBinding['bindingId'] },
      channelId,
    }).source.authorize()).toBe('revoked');
    expect(store.revokeBinding({ bindingId: binding.bindingId, generation: binding.generation }))
      .toMatchObject({ kind: 'done' });
    expect(await exact.authorize()).toBe('revoked');
  });

  it('treats lost membership and stale generations as lost authority for authorize and replay', async () => {
    const store = fresh();
    const old = transport(store).source;
    const stale = transport(store, { ...binding, generation: 99 }).source;
    const missing = transport(store, {
      ...binding,
      bindingId: 'binding-missing' as SessionBinding['bindingId'],
    }).source;
    expect(await stale.authorize()).toBe('revoked');
    expect(await stale.read({ cursor: null, limit: 10 })).toEqual({ kind: 'rejected', code: 'authority_lost' });
    expect(await missing.read({ cursor: null, limit: 10 })).toEqual({ kind: 'rejected', code: 'authority_lost' });

    expect(store.setMembership({ channelId, participantId: bob.participantId, membership: 'revoked' }))
      .toMatchObject({ kind: 'done' });
    expect(await old.authorize()).toBe('revoked');
    expect(await old.read({ cursor: null, limit: 10 })).toEqual({ kind: 'rejected', code: 'authority_lost' });
  });

  it('maps revoked binding replay to lost authority', async () => {
    const store = fresh();
    const source = transport(store).source;
    expect(store.revokeBinding({ bindingId: binding.bindingId, generation: binding.generation }))
      .toMatchObject({ kind: 'done' });
    expect(await source.read({ cursor: null, limit: 10 })).toEqual({ kind: 'rejected', code: 'authority_lost' });
  });
});

describe('local subscription source replay', () => {
  it('maps ordered eligible events to canonical source events and returns stable cursors', async () => {
    const store = fresh();
    const { source } = transport(store);
    expect(send(store, 1, alice, 'hello')).toMatchObject({ kind: 'stored' });
    const first = await source.read({ cursor: null, limit: 10 });
    expect(first).toEqual({
      kind: 'page',
      events: [{
        kind: 'decrypted',
        ref: {
          v: 1,
          roomId: channelId,
          eventId: 'event-1',
          authorParticipantId: alice.participantId,
          authorDeviceId: alice.deviceIds[0],
          contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
        verifiedDeviceId: alice.deviceIds[0],
        canonicalPayload: encodeMessageContent(text('hello')),
      }],
      nextCursor: expect.any(String),
      caughtUp: true,
    });
    expect(await source.read({ cursor: null, limit: 10 })).toEqual(first);
    expect(await source.read({ cursor: 'not-a-cursor', limit: 10 }))
      .toEqual({ kind: 'rejected', code: 'unsupported' });
  });

  it('advances across a filtered self row but leaves a peer lookahead for the next page', async () => {
    const store = fresh();
    const { source } = transport(store);
    send(store, 1, bob);
    send(store, 2, alice);

    const selfPage = await source.read({ cursor: null, limit: 1 });
    expect(selfPage).toMatchObject({ kind: 'page', events: [], caughtUp: false });
    const peerPage = await source.read({
      cursor: (selfPage as Extract<typeof selfPage, { kind: 'page' }>).nextCursor,
      limit: 1,
    });
    expect(peerPage).toMatchObject({ kind: 'page', events: [{ ref: { eventId: 'event-2' } }], caughtUp: true });
  });

  it('does not return or skip peer and self-authored lookahead rows', async () => {
    const store = fresh();
    const { source } = transport(store);
    send(store, 1, alice);
    send(store, 2, alice);
    send(store, 3, bob);

    const first = await source.read({ cursor: null, limit: 1 });
    expect(first).toMatchObject({ kind: 'page', events: [{ ref: { eventId: 'event-1' } }], caughtUp: false });
    const second = await source.read({ cursor: (first as Extract<typeof first, { kind: 'page' }>).nextCursor, limit: 1 });
    expect(second).toMatchObject({ kind: 'page', events: [{ ref: { eventId: 'event-2' } }], caughtUp: false });
    const third = await source.read({ cursor: (second as Extract<typeof second, { kind: 'page' }>).nextCursor, limit: 1 });
    expect(third).toMatchObject({ kind: 'page', events: [], caughtUp: true });
  });

  it('emits only content-free live hints, including for filtered own events, and disposes', () => {
    const store = fresh();
    const { source } = transport(store);
    const hint = vi.fn();
    const lost = vi.fn();
    const dispose = source.listen({ hint, lost });

    send(store, 1, bob, 'private body');
    expect(hint).toHaveBeenCalledOnce();
    expect(hint.mock.calls[0]).toEqual([]);
    expect(lost).not.toHaveBeenCalled();
    dispose();
    send(store, 2, alice);
    expect(hint).toHaveBeenCalledOnce();
  });

  it('preserves historical device provenance after an author leaves or is revoked', async () => {
    const store = fresh();
    const { provenance, source } = transport(store);
    expect(send(store, 1, alice, 'before leaving')).toMatchObject({ kind: 'stored' });
    expect(await provenance.participantForDevice({ roomId: channelId, deviceId: alice.deviceIds[0]! }))
      .toBe(alice.participantId);
    expect(await provenance.participantForDevice({ roomId: channelId, deviceId: bob.deviceIds[0]! }))
      .toBe(bob.participantId);
    expect(await provenance.participantForDevice({ roomId: channelId, deviceId: 'unknown' as DeviceId }))
      .toBeNull();
    expect(store.setMembership({ channelId, participantId: alice.participantId, membership: 'left' }))
      .toMatchObject({ kind: 'done' });
    expect(await provenance.participantForDevice({ roomId: channelId, deviceId: alice.deviceIds[0]! }))
      .toBe(alice.participantId);
    expect(store.setMembership({ channelId, participantId: alice.participantId, membership: 'revoked' }))
      .toMatchObject({ kind: 'done' });
    expect(await provenance.participantForDevice({ roomId: channelId, deviceId: alice.deviceIds[0]! }))
      .toBe(alice.participantId);
    expect(await source.read({ cursor: null, limit: 10 })).toMatchObject({
      kind: 'page',
      events: [{ ref: { eventId: 'event-1', authorParticipantId: alice.participantId } }],
    });
  });
});
