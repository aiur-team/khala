import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { createChannelStore, type ChannelStore, type RegisteredParticipant } from '../../store/channel-store';
import { openChannelStore, type InternalStoreHandle } from '../../store/open';
import { mintCredential, type BindingCredential, type BootstrapCredential } from '../credentials';

export const alice: RegisteredParticipant = {
  participantId: 'participant-alice' as ParticipantId,
  ownerId: 'owner-alice' as OwnerId,
  kind: 'human',
  displayName: 'Alice',
};
export const bob: RegisteredParticipant = {
  participantId: 'participant-bob' as ParticipantId,
  ownerId: 'owner-alice' as OwnerId,
  kind: 'agent',
  displayName: 'Bob',
};
export const carol: RegisteredParticipant = {
  participantId: 'participant-carol' as ParticipantId,
  ownerId: 'owner-alice' as OwnerId,
  kind: 'agent',
  displayName: 'Carol',
};
export const aliceDevice = 'device-alice' as DeviceId;
export const bobDevice = 'device-bob' as DeviceId;
export const carolDevice = 'device-carol' as DeviceId;
export const channelId = 'channel-one' as RoomId;
export const otherChannelId = 'channel-two' as RoomId;

export const bobBinding: SessionBinding = {
  v: 1,
  bindingId: 'binding-bob' as SessionBinding['bindingId'],
  ownerId: bob.ownerId,
  agentParticipantId: bob.participantId,
  deviceId: bobDevice,
  harness: 'codex',
  sessionId: 'session-bob',
  generation: 1,
};
export const carolBinding: SessionBinding = {
  ...bobBinding,
  bindingId: 'binding-carol' as SessionBinding['bindingId'],
  agentParticipantId: carol.participantId,
  deviceId: carolDevice,
  sessionId: 'session-carol',
};

export type ChannelFixture = Readonly<{
  root: string;
  handle: InternalStoreHandle;
  store: ChannelStore;
  bootstrap: BootstrapCredential;
  bob: BindingCredential;
  carol: BindingCredential;
  dispose(): void;
}>;

/** A real SQLite store with one human, two bound agents and two channels. */
export function createChannelFixture(input: Readonly<{ root: string; now: number }>): ChannelFixture {
  fs.chmodSync(input.root, 0o700);
  const handle = openChannelStore({ directory: path.join(input.root, 'state'), mode: 'create' });
  const store = createChannelStore(handle);
  for (const participant of [alice, bob, carol]) store.registerParticipant(participant);
  store.registerDevice({ deviceId: aliceDevice, participantId: alice.participantId });
  store.registerDevice({ deviceId: bobDevice, participantId: bob.participantId });
  store.registerDevice({ deviceId: carolDevice, participantId: carol.participantId });
  store.registerBinding(bobBinding);
  store.registerBinding(carolBinding);
  for (const [id, title] of [[channelId, 'One'], [otherChannelId, 'Two']] as const) {
    const created = store.createChannel({
      operationId: `create-${id}`, channelId: id, title, creatorOwnerId: alice.ownerId,
      creatorParticipantId: alice.participantId, creatorDeviceId: aliceDevice, createdAt: new Date(input.now).toISOString(),
    });
    if (created.kind !== 'created') throw new Error('fixture channel');
  }
  store.setMembership({ channelId, participantId: bob.participantId, membership: 'joined' });
  store.setMembership({ channelId: otherChannelId, participantId: carol.participantId, membership: 'joined' });
  return {
    root: input.root,
    handle,
    store,
    bootstrap: {
      credential: mintCredential(),
      channelId,
      expiresAt: input.now + 60_000,
      human: { ownerId: alice.ownerId, participantId: alice.participantId, deviceId: aliceDevice },
    },
    bob: { credential: mintCredential(), binding: bobBinding, channels: [channelId] },
    carol: { credential: mintCredential(), binding: carolBinding, channels: [otherChannelId] },
    dispose() {
      handle.close();
      fs.rmSync(input.root, { recursive: true, force: true });
    },
  };
}
