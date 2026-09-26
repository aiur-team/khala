import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFECYCLE_CHANNEL_META_KEY, bindLifecycleChannel } from '../store/lifecycle-snapshot';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { ROOM_DATABASE_FILE } from '../store/path';
import { directoryFor, makeRoot, seedChannel, tree } from './fixtures/channel';
import { CHANNELS_DIRECTORY, channelDirectory, channelDirectorySegment } from './paths';
import { resumeInternalChannel } from './resume';

const roots: string[] = [];
const handles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function resume(root: string, channelId: string) {
  const result = resumeInternalChannel({ root, channelId });
  if (result.kind === 'resumed') handles.push(result.handle);
  return result;
}

describe('channel directory codec', () => {
  it('pins a domain-separated fixed-length segment below the channels directory', () => {
    expect(channelDirectorySegment('channel-one')).toBe(channelDirectorySegment('channel-one'));
    expect(channelDirectorySegment('channel-one')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(channelDirectorySegment('channel-one')).not.toBe(channelDirectorySegment('channel-two'));
    for (const hostile of ['../escape', '/etc/passwd', '.', '..', 'a/b', 'é'.repeat(300), 'x'.repeat(1_024)]) {
      const directory = channelDirectory('/srv/khala', hostile);
      expect(directory && path.dirname(directory)).toBe(path.join('/srv/khala', CHANNELS_DIRECTORY));
      expect(path.basename(directory ?? '')).toHaveLength(43);
    }
  });

  it('refuses unusable roots and channel IDs', () => {
    for (const root of ['relative', '/srv/../srv/khala', '/srv/khala/']) expect(channelDirectory(root, 'c')).toBeNull();
    for (const id of ['', 'a\0b', 'x'.repeat(1_025), '\ud800']) expect(channelDirectory('/srv/khala', id)).toBeNull();
  });
});

describe('resumeInternalChannel', () => {
  it('returns stable versioned metadata for the exact channel across restart', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'alice', body: 'hello' }, { author: 'bob', body: 'hi' }]);
    const first = resume(root, 'channel-one');
    expect(first).toMatchObject({
      kind: 'resumed',
      v: 1,
      metadata: {
        v: 1,
        channelId: 'channel-one',
        title: 'Fixture channel',
        createdAt: '2026-09-24T20:00:00.000Z',
        creatorParticipantId: 'participant-alice',
        creatorDeviceId: 'device-alice',
        participantCount: 2,
        eventCount: 2,
        latestSequence: 2,
      },
    });
    if (first.kind !== 'resumed') return;
    first.handle.close();
    const second = resume(root, 'channel-one');
    expect(second.kind === 'resumed' && second.metadata).toEqual(first.metadata);
  });

  it('holds exclusive ownership and refuses a second opener as channel_running', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one');
    expect(resume(root, 'channel-one').kind).toBe('resumed');
    expect(resume(root, 'channel-one')).toEqual({ kind: 'failed', code: 'channel_running' });
  });

  it('refuses missing state without creating any directory, database or companion', () => {
    const root = makeRoot(roots);
    const before = tree(root);
    expect(resume(root, 'channel-missing')).toEqual({ kind: 'failed', code: 'missing_state' });
    fs.mkdirSync(directoryFor(root, 'channel-empty'), { mode: 0o700 });
    const withEmpty = tree(root);
    expect(resume(root, 'channel-empty')).toEqual({ kind: 'failed', code: 'missing_state' });
    expect(tree(root)).toEqual(withEmpty);
    expect(Object.keys(before)).toEqual([CHANNELS_DIRECTORY]);
  });

  it('refuses corrupt and newer state byte-for-byte', () => {
    const root = makeRoot(roots);
    const corrupt = directoryFor(root, 'channel-corrupt');
    fs.mkdirSync(corrupt, { mode: 0o700 });
    fs.writeFileSync(path.join(corrupt, ROOM_DATABASE_FILE), 'not sqlite'.repeat(20), { mode: 0o600 });
    const before = tree(root);
    expect(resume(root, 'channel-corrupt')).toEqual({ kind: 'failed', code: 'corrupt' });
    expect(tree(root)).toEqual(before);

    const newer = seedChannel(root, 'channel-newer');
    const raw = new DatabaseSync(path.join(newer, ROOM_DATABASE_FILE));
    raw.exec('PRAGMA journal_mode = DELETE');
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(resume(root, 'channel-newer')).toEqual({ kind: 'failed', code: 'schema_unsupported' });
  });

  it('refuses a foreign channel placed at another channel path', () => {
    const root = makeRoot(roots);
    const foreign = seedChannel(root, 'channel-foreign');
    const target = directoryFor(root, 'channel-one');
    fs.renameSync(foreign, target);
    expect(resume(root, 'channel-one')).toEqual({ kind: 'failed', code: 'identity_mismatch' });
    expect(resume(root, 'channel-foreign')).toEqual({ kind: 'failed', code: 'missing_state' });
  });

  it('refuses ambiguous unbound multi-channel state and a mismatched bound identity', () => {
    const root = makeRoot(roots);
    const extraChannel = (handle: InternalStoreHandle) => handle.transaction(db => {
      db.prepare(`
        INSERT INTO channels (channel_id, title, creator_participant_id, creator_device_id, revision, created_at)
        VALUES ('channel-two', NULL, 'participant-alice', 'device-alice', 0, '2026-09-24T20:00:00.000Z')
      `).run();
    });
    seedChannel(root, 'channel-one', [], { bind: false, extra: extraChannel });
    expect(resume(root, 'channel-one')).toEqual({ kind: 'failed', code: 'identity_mismatch' });
    // A bound store keeps its launch identity when an owner-confirmed create adds a channel to it.
    seedChannel(root, 'channel-bound', [], { extra: extraChannel });
    expect(resume(root, 'channel-bound')).toMatchObject({ kind: 'resumed', metadata: { channelId: 'channel-bound' } });

    seedChannel(root, 'channel-three', [], {
      extra: handle => handle.transaction(db => {
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('channel-other', LIFECYCLE_CHANNEL_META_KEY);
      }),
    });
    expect(resume(root, 'channel-three')).toEqual({ kind: 'failed', code: 'identity_mismatch' });
  });

  it('binds a legacy single-channel store only to its exact channel', () => {
    const root = makeRoot(roots);
    const directory = seedChannel(root, 'channel-legacy', [], { bind: false, title: null });
    const handle = openChannelStore({ directory, mode: 'existing' });
    handles.push(handle);
    expect(bindLifecycleChannel(handle, 'channel-wrong')).toEqual({ kind: 'identity_mismatch' });
    expect(bindLifecycleChannel(handle, 'channel-legacy')).toEqual({ kind: 'bound', changed: true });
    expect(bindLifecycleChannel(handle, 'channel-legacy')).toEqual({ kind: 'bound', changed: false });
    handle.close();
    expect(resume(root, 'channel-legacy')).toMatchObject({ kind: 'resumed', metadata: { title: null, latestSequence: null } });
  });

  it('refuses invalid requests and a symlinked channel directory', () => {
    const root = makeRoot(roots);
    expect(resume('relative', 'channel-one')).toEqual({ kind: 'failed', code: 'invalid_request' });
    expect(resume(root, '')).toEqual({ kind: 'failed', code: 'invalid_request' });
    const real = seedChannel(root, 'channel-real');
    fs.symlinkSync(real, directoryFor(root, 'channel-one'));
    expect(resume(root, 'channel-one')).toEqual({ kind: 'failed', code: 'unsafe_path' });
  });
});
