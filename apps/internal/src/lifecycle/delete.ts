import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readResumeMetadata, removeCreatedChannel } from '../store/lifecycle-snapshot';
import { StoreError } from '../store/errors';
import { openChannelStore } from '../store/open';
import { CHANNELS_DIRECTORY, isLifecycleChannelId, isNormalAbsolute } from './paths';
import { type LifecycleOpenFailureCode, isOpenFailure, lifecycleFailure, openOwnedChannel } from './resume';

/** Every surface that offers or reports deletion must show this boundary. */
export const PLAINTEXT_DELETION_NOTICE = 'Internal channel data is stored in plaintext. '
  + 'Deletion removes files but does not securely erase underlying storage.';

export type DeleteConfirmationV1 = Readonly<{ kind: 'delete_internal_channel'; v: 1; channelId: string }>;

/** A later CLI `--yes` or browser approval must produce exactly this object. */
export function deleteConfirmation(channelId: string): DeleteConfirmationV1 {
  return { kind: 'delete_internal_channel', v: 1, channelId };
}

/**
 * `channels_remain`: the launch channel names its store directory, so it is deleted
 * only once the channels created in that store are gone; nothing was removed.
 */
export type DeleteFailureCode = LifecycleOpenFailureCode | 'tombstone_collision' | 'channels_remain';

export type DeleteResultV1 =
  | Readonly<{ kind: 'deleted'; v: 1; channelId: string; notice: typeof PLAINTEXT_DELETION_NOTICE }>
  | Readonly<{ kind: 'incomplete'; v: 1; channelId: string; tombstone: string; notice: typeof PLAINTEXT_DELETION_NOTICE }>
  | Readonly<{ kind: 'confirmation_required'; v: 1; channelId: string; notice: typeof PLAINTEXT_DELETION_NOTICE }>
  | Readonly<{ kind: 'failed'; code: DeleteFailureCode }>;

/** Test-only deterministic interruption after the channel becomes a tombstone. */
export type DeleteFaultStage = 'after_tombstone' | 'before_unlink';
export type DeleteFault = (stage: DeleteFaultStage) => void;

function confirmed(confirmation: unknown, channelId: string): boolean {
  const value = confirmation as Partial<DeleteConfirmationV1> | null | undefined;
  return typeof value === 'object' && value !== null && value.kind === 'delete_internal_channel'
    && value.v === 1 && value.channelId === channelId;
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch {}
}

/** Removes a pinned tree with lstat semantics: symlinks are unlinked, never followed. */
function removeTree(directory: string, fault: DeleteFault | undefined): void {
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    if (fs.lstatSync(entry).isDirectory()) {
      removeTree(entry, fault);
    } else {
      fault?.('before_unlink');
      fs.unlinkSync(entry);
    }
  }
  fs.rmdirSync(directory);
}

/**
 * A channel an owner-confirmed create added to some launch store has no directory of
 * its own. Each other offline store is checked for it, and only its rows are removed.
 */
function deleteCreatedChannel(root: string, channelId: string): DeleteResultV1 {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, CHANNELS_DIRECTORY));
  } catch {
    return lifecycleFailure('missing_state');
  }
  let running = false;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let handle: ReturnType<typeof openChannelStore>;
    try {
      handle = openChannelStore({ directory: path.join(root, CHANNELS_DIRECTORY, name), mode: 'existing' });
    } catch (error) {
      running ||= error instanceof StoreError && error.code === 'locked';
      continue;
    }
    try {
      if (removeCreatedChannel(handle, channelId).kind === 'removed') {
        return { kind: 'deleted', v: 1, channelId, notice: PLAINTEXT_DELETION_NOTICE };
      }
    } catch {
      return lifecycleFailure('unavailable');
    } finally {
      handle.close();
    }
  }
  // A running launch may hold it; lifecycle changes wait until that launch stops.
  return lifecycleFailure(running ? 'channel_running' : 'missing_state');
}

/**
 * Deletes one confirmed offline channel. Ownership is retained while the exact
 * directory is renamed into a fresh same-parent tombstone, so no other owner can
 * open it mid-delete. A failure after that rename never recreates the original
 * path; it reports the tombstone for later recovery.
 */
export function deleteInternalChannel(input: Readonly<{
  root: string;
  channelId: string;
  confirmation: unknown;
  /** Test-only tombstone name source. */
  tombstoneSuffix?: () => string;
  fault?: DeleteFault;
}>): DeleteResultV1 {
  if (!confirmed(input.confirmation, input.channelId)) {
    return { kind: 'confirmation_required', v: 1, channelId: input.channelId, notice: PLAINTEXT_DELETION_NOTICE };
  }
  const owned = openOwnedChannel(input.root, input.channelId);
  if (isOpenFailure(owned)) {
    return owned.code === 'missing_state' && isNormalAbsolute(input.root) && isLifecycleChannelId(input.channelId)
      ? deleteCreatedChannel(input.root, input.channelId)
      : owned;
  }

  const parent = path.dirname(owned.directory);
  const tombstone = path.join(parent, `.tombstone-${input.tombstoneSuffix?.() ?? randomBytes(12).toString('hex')}`);
  const moved = path.join(tombstone, 'channel');
  let pinned: fs.Stats;
  try {
    const identity = readResumeMetadata(owned.handle, input.channelId);
    if (identity.kind !== 'found') {
      owned.handle.close();
      return lifecycleFailure(identity.kind);
    }
    // Removing the directory would take every channel created in this store with it.
    const others = owned.handle.read(db => db.prepare('SELECT 1 FROM channels WHERE channel_id <> ? LIMIT 1').get(input.channelId));
    if (others) {
      owned.handle.close();
      return lifecycleFailure('channels_remain');
    }
    pinned = fs.lstatSync(owned.directory);
    if (!pinned.isDirectory()) {
      owned.handle.close();
      return lifecycleFailure('unsafe_path');
    }
    // An exclusive fresh container guarantees the rename target is absent.
    fs.mkdirSync(tombstone, { mode: 0o700 });
  } catch (error) {
    owned.handle.close();
    return lifecycleFailure((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'tombstone_collision' : 'unavailable');
  }
  try {
    fs.renameSync(owned.directory, moved);
  } catch {
    try { fs.rmdirSync(tombstone); } catch {}
    owned.handle.close();
    return lifecycleFailure('unavailable');
  }
  syncDirectory(parent);
  // The original path no longer exists, so SQLite cannot recreate files there on close.
  try { owned.handle.close(); } catch {}

  try {
    input.fault?.('after_tombstone');
    const current = fs.lstatSync(moved);
    if (!current.isDirectory() || current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error('moved');
    removeTree(tombstone, input.fault);
    syncDirectory(parent);
  } catch {
    return { kind: 'incomplete', v: 1, channelId: input.channelId, tombstone, notice: PLAINTEXT_DELETION_NOTICE };
  }
  return { kind: 'deleted', v: 1, channelId: input.channelId, notice: PLAINTEXT_DELETION_NOTICE };
}
