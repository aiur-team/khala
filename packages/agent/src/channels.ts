import * as fs from 'node:fs/promises';
import path from 'node:path';
import { appendEntries, readCursor, unread } from './inbox';
import { channelFiles, channelsDir, ensureStateDir, filesForDir, readJson, readStatus, removeStateFile, stateKey, StateError, writeStateFile, type SessionFiles } from './state';

export type ChannelRef = { key: string; roomId: string; channelName?: string; files: SessionFiles; legacy: boolean };
type ChannelMetadata = { roomId: string; channelName?: string; joinedAt: string };
export function channelKey(roomId: string): string { return stateKey(roomId); }

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new StateError('storage_failed');
  }
}
function roomId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'roomId' in value && typeof value.roomId === 'string' && value.roomId.length) return value.roomId;
  return undefined;
}
async function legacyRoomId(files: SessionFiles): Promise<string | undefined> {
  const saved = roomId(await readJson(files.session));
  if (saved) return saved;
  let content: string;
  try { content = await fs.readFile(files.inbox, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new StateError('storage_failed');
  }
  try { return roomId(JSON.parse(content.split('\n')[0]!)); } catch { return undefined; }
}

export async function listChannels(files: SessionFiles): Promise<ChannelRef[]> {
  await ensureStateDir(files.dir);
  const channels: ChannelRef[] = [];
  const dir = channelsDir(files);
  if (await exists(dir)) {
    await ensureStateDir(dir);
    for (const key of await fs.readdir(dir)) {
      if (!/^[a-f0-9]{24}$/.test(key)) continue;
      const nested = filesForDir(path.join(dir, key));
      await ensureStateDir(nested.dir);
      const metadata = await readJson<ChannelMetadata | null>(path.join(nested.dir, 'channel.json'));
      const id = roomId(metadata);
      if (!id || channelKey(id) !== key) continue;
      channels.push({ key, roomId: id, ...(typeof metadata?.channelName === 'string' ? { channelName: metadata.channelName } : {}), files: nested, legacy: false });
    }
  }
  if (await exists(files.inbox)) {
    const id = await legacyRoomId(files);
    if (id) {
      const status = await readStatus(files);
      channels.push({ key: channelKey(id), roomId: id, ...(typeof status?.channelName === 'string' ? { channelName: status.channelName } : {}), files, legacy: true });
    }
  }
  return channels.sort((a, b) => (a.channelName ?? '').localeCompare(b.channelName ?? '') || a.roomId.localeCompare(b.roomId));
}

export async function migrateLegacy(files: SessionFiles): Promise<'none' | 'moved' | 'discarded'> {
  await ensureStateDir(files.dir);
  const names = ['cursor.json', 'mode.json', 'inbox.jsonl'] as const;
  const present = await Promise.all(names.map(name => exists(path.join(files.dir, name))));
  if (!present.some(Boolean)) return 'none';
  const id = await legacyRoomId(files);
  if (!id) {
    for (const name of names) await removeStateFile(files.dir, name);
    return 'discarded';
  }
  const nested = channelFiles(files, id);
  await ensureStateDir(nested.dir);
  const destinationInbox = await exists(nested.inbox);
  if (!destinationInbox && present[0] && await exists(nested.cursor)) {
    const [legacyCursor, channelCursor] = await Promise.all([readCursor(files), readCursor(nested)]);
    if (legacyCursor.deliveredCount !== channelCursor.deliveredCount || legacyCursor.lastDeliveredEventId !== channelCursor.lastDeliveredEventId) {
      // Both cursors will index the legacy inbox. Prefer replay over skipping unread messages.
      const safe = legacyCursor.deliveredCount < channelCursor.deliveredCount ? legacyCursor : channelCursor;
      await writeStateFile(nested.dir, 'cursor.json', safe);
      console.warn(`Khala cursor migration: conflicting cursors for ${id}; using earlier position ${safe.deliveredCount} to avoid skipping messages (legacy=${legacyCursor.deliveredCount}, channel=${channelCursor.deliveredCount}).`);
    }
  }
  const status = await readStatus(files);
  // Publish metadata before moving the inbox, which is the legacy-presence marker.
  // A restart after any rename can reuse the root credentials or remaining inbox.
  const metadata = await readJson<ChannelMetadata>(path.join(nested.dir, 'channel.json'));
  if (!metadata || roomId(metadata) !== id) {
    await writeStateFile(nested.dir, 'channel.json', { roomId: id,
      ...(typeof status?.channelName === 'string' ? { channelName: status.channelName } : {}), joinedAt: new Date().toISOString() });
  }
  if (destinationInbox) {
    if (present[2]) await appendEntries(nested, (await unread(files)).entries);
    // Inbox is the source-presence marker. Remove it before its cursor so a
    // restart cannot append delivered entries as unread; append dedupes retries.
    for (const name of ['inbox.jsonl', 'cursor.json', 'mode.json']) await removeStateFile(files.dir, name);
    return 'moved';
  }
  for (const name of names) {
    // A cursor already moved by an interrupted migration must remain in place.
    // Existing channel modes likewise take precedence over the legacy mode.
    if (await exists(path.join(nested.dir, name))) {
      await removeStateFile(files.dir, name);
      continue;
    }
    try { await fs.rename(path.join(files.dir, name), path.join(nested.dir, name)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StateError('storage_failed');
    }
  }
  return 'moved';
}

export function resolveChannel(list: readonly ChannelRef[], ref: string | undefined):
  | { ok: true; channel: ChannelRef }
  | { ok: false; code: 'channel_required' | 'channel_unknown' | 'channel_ambiguous'; channels: { channel: string; roomId: string }[] } {
  const channels = list.map(item => ({ channel: item.channelName ?? item.roomId, roomId: item.roomId }));
  if (ref === undefined) {
    if (list.length === 1) return { ok: true, channel: list[0]! };
    return { ok: false, code: list.length ? 'channel_required' : 'channel_unknown', channels };
  }
  const exact = list.find(item => item.roomId === ref);
  if (exact) return { ok: true, channel: exact };
  const normalized = ref.replace(/^#/, '').toLowerCase();
  const matches = list.filter(item => item.channelName?.replace(/^#/, '').toLowerCase() === normalized);
  if (matches.length === 1) return { ok: true, channel: matches[0]! };
  return { ok: false, code: matches.length ? 'channel_ambiguous' : 'channel_unknown', channels };
}
