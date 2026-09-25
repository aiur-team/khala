import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { createChannelStore } from '../../store/channel-store';
import { bindLifecycleChannel } from '../../store/lifecycle-snapshot';
import { type InternalStoreHandle, openChannelStore } from '../../store/open';
import { CHANNELS_DIRECTORY, channelDirectory } from '../paths';

// Secret canaries live in every table and file an export must never read.
export const SECRET_CANARIES = [
  'CANARY-OWNER-ALICE',
  'CANARY-OWNER-BOB',
  'CANARY-BINDING',
  'CANARY-SESSION',
  'CANARY-OPERATION',
  'CANARY-LAUNCH-TOKEN',
  'CANARY-TXN',
  'sha256:',
] as const;

export const alice = {
  participantId: 'participant-alice' as ParticipantId,
  ownerId: 'CANARY-OWNER-ALICE' as OwnerId,
  kind: 'human' as const,
  displayName: 'Alice',
};
export const bob = {
  participantId: 'participant-bob' as ParticipantId,
  ownerId: 'CANARY-OWNER-BOB' as OwnerId,
  kind: 'agent' as const,
  displayName: 'Bob',
};
export const aliceDevice = 'device-alice' as DeviceId;
export const bobDevice = 'device-bob' as DeviceId;

export type SeedMessage = Readonly<{ author: 'alice' | 'bob'; body: string }>;

export function makeRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-lifecycle-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, CHANNELS_DIRECTORY), { mode: 0o700 });
  return root;
}

export function directoryFor(root: string, channelId: string): string {
  const directory = channelDirectory(root, channelId);
  if (directory === null) throw new Error('invalid fixture channel');
  return directory;
}

/** Creates a complete bound channel and closes its owner. */
export function seedChannel(
  root: string,
  channelId: string,
  messages: readonly SeedMessage[] = [],
  options: Readonly<{ title?: string | null; bind?: boolean; extra?: (handle: InternalStoreHandle) => void }> = {},
): string {
  const directory = directoryFor(root, channelId);
  const handle = openChannelStore({ directory, mode: 'create' });
  try {
    const store = createChannelStore(handle);
    store.registerParticipant(alice);
    store.registerParticipant(bob);
    store.registerDevice({ deviceId: aliceDevice, participantId: alice.participantId });
    store.registerDevice({ deviceId: bobDevice, participantId: bob.participantId });
    const binding: SessionBinding = {
      v: 1,
      bindingId: 'CANARY-BINDING' as SessionBinding['bindingId'],
      ownerId: bob.ownerId,
      agentParticipantId: bob.participantId,
      deviceId: bobDevice,
      harness: 'codex',
      sessionId: 'CANARY-SESSION',
      generation: 1,
    };
    if (store.registerBinding(binding).kind !== 'done') throw new Error('fixture binding');
    const created = store.createChannel({
      operationId: 'CANARY-OPERATION',
      channelId: channelId as RoomId,
      title: options.title === undefined ? 'Fixture channel' : options.title,
      creatorOwnerId: alice.ownerId,
      creatorParticipantId: alice.participantId,
      creatorDeviceId: aliceDevice,
      createdAt: '2026-09-24T20:00:00.000Z',
    });
    if (created.kind !== 'created') throw new Error('fixture channel');
    store.setMembership({ channelId: channelId as RoomId, participantId: bob.participantId, membership: 'joined' });
    messages.forEach((message, index) => {
      const author = message.author === 'alice'
        ? { participantId: alice.participantId, deviceId: aliceDevice }
        : { participantId: bob.participantId, deviceId: bobDevice };
      const sent = store.send({
        channelId: channelId as RoomId,
        eventId: `event-${index + 1}` as EventId,
        authorParticipantId: author.participantId,
        authorDeviceId: author.deviceId,
        clientTxnId: `CANARY-TXN-${index + 1}`,
        content: { v: 1, kind: 'text', body: message.body },
        receivedAt: `2026-09-24T20:01:${String(index).padStart(2, '0')}.000Z`,
      });
      if (sent.kind !== 'stored') throw new Error('fixture send');
    });
    handle.transaction(db => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('launch.token', 'CANARY-LAUNCH-TOKEN')").run();
    });
    if (options.bind !== false && bindLifecycleChannel(handle, channelId).kind !== 'bound') throw new Error('fixture bind');
    options.extra?.(handle);
  } finally {
    handle.close();
  }
  fs.writeFileSync(path.join(directory, 'launch.json'), '{"token":"CANARY-LAUNCH-TOKEN"}', { mode: 0o600 });
  return directory;
}

export function tree(target: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const entry = path.join(current, name);
      const stats = fs.lstatSync(entry);
      const relative = path.relative(target, entry);
      if (stats.isDirectory()) {
        entries[relative] = 'dir';
        walk(entry);
      } else if (stats.isSymbolicLink()) {
        entries[relative] = `link:${fs.readlinkSync(entry)}`;
      } else {
        entries[relative] = fs.readFileSync(entry).toString('base64');
      }
    }
  };
  walk(target);
  return entries;
}
