import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { EventId, RoomId } from '@khala/contracts/messaging/index';
import { createChannelStore } from '../store/channel-store';
import { createDiscoveryStore } from '../store/discovery-store';
import { LIFECYCLE_CHANNEL_META_KEY } from '../store/lifecycle-snapshot';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { alice, aliceDevice, bob, bobDevice, directoryFor, makeRoot, seedChannel, tree } from './fixtures/channel';
import { PLAINTEXT_DELETION_NOTICE, deleteConfirmation, deleteInternalChannel } from './delete';
import { CHANNELS_DIRECTORY } from './paths';

const roots: string[] = [];
const handles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function remove(root: string, channelId: string, extra: Partial<Parameters<typeof deleteInternalChannel>[0]> = {}) {
  return deleteInternalChannel({ root, channelId, confirmation: deleteConfirmation(channelId), ...extra });
}

/** Adds two channels the way an owner-confirmed create request does, each with a message and one activated binding. */
function addCreatedChannels(handle: InternalStoreHandle): void {
  const discovery = createDiscoveryStore(handle);
  const store = createChannelStore(handle);
  for (const [index, channelId] of ['channel-created-1', 'channel-created-2'].entries()) {
    const created = discovery.createSecretChannel({
      idempotencyKey: `create-${index}`, channelId, title: `Created ${index}`, ownerId: alice.ownerId,
      creatorParticipantId: alice.participantId, creatorDeviceId: aliceDevice, createdAt: '2026-09-24T21:00:00.000Z',
    });
    if (created.kind !== 'created') throw new Error('fixture create');
    store.setMembership({ channelId: channelId as RoomId, participantId: bob.participantId, membership: 'joined' });
    const sent = store.send({
      channelId: channelId as RoomId, eventId: `event-created-${index}` as EventId, authorParticipantId: bob.participantId,
      authorDeviceId: bobDevice, clientTxnId: `txn-created-${index}`, content: { v: 1, kind: 'text', body: `in ${channelId}` },
      receivedAt: '2026-09-24T21:01:00.000Z',
    });
    if (sent.kind !== 'stored') throw new Error('fixture send');
    const binding: SessionBinding = {
      v: 1, bindingId: `binding-${channelId}` as SessionBinding['bindingId'], ownerId: bob.ownerId,
      agentParticipantId: bob.participantId, deviceId: bobDevice, harness: 'codex', sessionId: 'session-digest', generation: 1,
    };
    if (discovery.activate({ operationKey: `op-${channelId}`, binding, channelId, sessionGeneration: 1 }).kind !== 'activated') {
      throw new Error('fixture activation');
    }
  }
}

function channelRows(directory: string) {
  const handle = openChannelStore({ directory, mode: 'existing' });
  try {
    return handle.read(db => ({
      channels: db.prepare('SELECT channel_id FROM channels ORDER BY channel_id').all().map(row => row.channel_id),
      events: db.prepare('SELECT channel_id FROM events ORDER BY channel_id').all().map(row => row.channel_id),
      memberships: db.prepare('SELECT DISTINCT channel_id FROM memberships ORDER BY channel_id').all().map(row => row.channel_id),
      bindings: db.prepare("SELECT binding_id, status FROM bindings WHERE binding_id LIKE 'binding-%' ORDER BY binding_id").all(),
    }));
  } finally {
    handle.close();
  }
}

describe('deleteInternalChannel', () => {
  it('requires confirmation bound to the exact channel before any filesystem access', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-one');
    const before = tree(root);
    for (const confirmation of [undefined, null, {}, deleteConfirmation('channel-two'),
      { ...deleteConfirmation('channel-one'), v: 2 }, { ...deleteConfirmation('channel-one'), kind: 'delete' }]) {
      expect(deleteInternalChannel({ root, channelId: 'channel-one', confirmation })).toEqual({
        kind: 'confirmation_required', v: 1, channelId: 'channel-one', notice: PLAINTEXT_DELETION_NOTICE,
      });
    }
    // An unconfirmed request never touches the filesystem, even for an unusable root.
    expect(deleteInternalChannel({ root: 'relative', channelId: 'x', confirmation: null }).kind).toBe('confirmation_required');
    expect(tree(root)).toEqual(before);
    expect(fs.existsSync(directory)).toBe(true);
  });

  it('removes only the named channel and reports the no-secure-erase boundary', () => {
    const root = makeRoot(roots);
    const target = seedChannel(root, 'channel-one', [{ author: 'alice', body: 'goodbye' }]);
    const sibling = seedChannel(root, 'channel-two', [{ author: 'bob', body: 'stay' }]);
    const siblingBefore = tree(sibling);
    expect(remove(root, 'channel-one')).toEqual({
      kind: 'deleted', v: 1, channelId: 'channel-one', notice: PLAINTEXT_DELETION_NOTICE,
    });
    expect(PLAINTEXT_DELETION_NOTICE).toContain('does not securely erase');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.join(root, CHANNELS_DIRECTORY))).toEqual([path.basename(sibling)]);
    expect(tree(sibling)).toEqual(siblingBefore);
    expect(remove(root, 'channel-one')).toEqual({ kind: 'failed', code: 'missing_state' });
  });

  it('deletes a channel created in a launch store and nothing else in that store', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-launch', [{ author: 'alice', body: 'launch stays' }], { extra: addCreatedChannels });
    const siblingDirectory = seedChannel(root, 'channel-sibling', [{ author: 'bob', body: 'sibling stays' }]);
    const sibling = tree(siblingDirectory);

    expect(remove(root, 'channel-created-1')).toEqual({
      kind: 'deleted', v: 1, channelId: 'channel-created-1', notice: PLAINTEXT_DELETION_NOTICE,
    });
    expect(channelRows(directory)).toEqual({
      channels: ['channel-created-2', 'channel-launch'],
      events: ['channel-created-2', 'channel-launch'],
      memberships: ['channel-created-2', 'channel-launch'],
      // The deleted channel's binding stops working; the other channel's binding is untouched.
      bindings: [
        { binding_id: 'binding-channel-created-1', status: 'revoked' },
        { binding_id: 'binding-channel-created-2', status: 'active' },
      ],
    });
    expect(tree(siblingDirectory)).toEqual(sibling);
    expect(remove(root, 'channel-created-1')).toEqual({ kind: 'failed', code: 'missing_state' });

    // The launch channel names the store, so it cannot be deleted out from under a created channel.
    expect(remove(root, 'channel-launch')).toEqual({ kind: 'failed', code: 'channels_remain' });
    expect(channelRows(directory).channels).toEqual(['channel-created-2', 'channel-launch']);

    // A running launch keeps its channels until it stops.
    const running = openChannelStore({ directory, mode: 'existing' });
    handles.push(running);
    expect(remove(root, 'channel-created-2')).toEqual({ kind: 'failed', code: 'channel_running' });
    handles.pop()!.close();
    expect(remove(root, 'channel-created-2').kind).toBe('deleted');
    expect(remove(root, 'channel-launch').kind).toBe('deleted');
    expect(fs.existsSync(directory)).toBe(false);
    expect(tree(siblingDirectory)).toEqual(sibling);
  });

  it('refuses a running channel without changing it', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-one');
    const handle = openChannelStore({ directory, mode: 'existing' });
    handles.push(handle);
    expect(remove(root, 'channel-one')).toEqual({ kind: 'failed', code: 'channel_running' });
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.readdirSync(path.join(root, CHANNELS_DIRECTORY))).toEqual([path.basename(directory)]);
  });

  it('refuses a store whose bound identity names another channel', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-one', [], {
      extra: handle => handle.transaction(db => {
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('channel-other', LIFECYCLE_CHANNEL_META_KEY);
      }),
    });
    const before = tree(root);
    expect(remove(root, 'channel-one')).toEqual({ kind: 'failed', code: 'identity_mismatch' });
    expect(fs.existsSync(directory)).toBe(true);
    // Only SQLite sidecar churn from the refused open is permitted.
    expect(Object.keys(tree(root)).filter(name => !/-(wal|shm)$/.test(name))).toEqual(
      Object.keys(before).filter(name => !/-(wal|shm)$/.test(name)),
    );
  });

  it('refuses a top-level symlink without touching its target', () => {
    const root = makeRoot(roots);
    const real = seedChannel(root, 'channel-real');
    const before = tree(real);
    const link = directoryFor(root, 'channel-one');
    fs.symlinkSync(real, link);
    expect(remove(root, 'channel-one')).toEqual({ kind: 'failed', code: 'unsafe_path' });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(tree(real)).toEqual(before);
  });

  it('unlinks nested symlinks without following them to external targets', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-one');
    const sibling = seedChannel(root, 'channel-two');
    const external = fs.mkdtempSync(path.join('/tmp', 'khala-external-'));
    roots.push(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(directory, 'nested'));
    fs.symlinkSync(external, path.join(directory, 'nested', 'to-external-dir'));
    fs.symlinkSync(path.join(external, 'keep.txt'), path.join(directory, 'to-external-file'));
    fs.symlinkSync(sibling, path.join(directory, 'to-sibling'));
    const siblingBefore = tree(sibling);
    expect(remove(root, 'channel-one').kind).toBe('deleted');
    expect(fs.existsSync(directory)).toBe(false);
    expect(tree(external)).toEqual({ 'keep.txt': Buffer.from('keep').toString('base64') });
    expect(tree(sibling)).toEqual(siblingBefore);
  });

  it('refuses a tombstone collision before moving the channel', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-one');
    const collision = path.join(root, CHANNELS_DIRECTORY, '.tombstone-fixed');
    fs.mkdirSync(collision);
    fs.writeFileSync(path.join(collision, 'other'), 'other');
    const before = tree(root);
    expect(remove(root, 'channel-one', { tombstoneSuffix: () => 'fixed' }))
      .toEqual({ kind: 'failed', code: 'tombstone_collision' });
    expect(Object.keys(tree(root)).filter(name => !/-(wal|shm)$/.test(name))).toEqual(
      Object.keys(before).filter(name => !/-(wal|shm)$/.test(name)),
    );
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.readFileSync(path.join(collision, 'other'), 'utf8')).toBe('other');
  });

  it('reports incomplete cleanup and preserves the tombstone after a post-rename failure', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-one', [{ author: 'alice', body: 'partial' }]);
    for (const stage of ['after_tombstone', 'before_unlink'] as const) {
      const channelId = stage === 'after_tombstone' ? 'channel-one' : 'channel-two';
      const target = stage === 'after_tombstone' ? directory : seedChannel(root, channelId);
      const result = remove(root, channelId, {
        tombstoneSuffix: () => stage,
        fault: current => { if (current === stage) throw new Error('injected'); },
      });
      const tombstone = path.join(root, CHANNELS_DIRECTORY, `.tombstone-${stage}`);
      expect(result).toEqual({ kind: 'incomplete', v: 1, channelId, tombstone, notice: PLAINTEXT_DELETION_NOTICE });
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(path.join(tombstone, 'channel', 'room.sqlite'))).toBe(true);
    }
    // Nothing reopens at the original path after an incomplete delete.
    expect(remove(root, 'channel-one')).toEqual({ kind: 'failed', code: 'missing_state' });
  });
});
