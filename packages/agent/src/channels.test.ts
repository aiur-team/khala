import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendEntries, readEntries, unread } from './inbox';
import { channelKey, listChannels, migrateLegacy, resolveChannel, type ChannelRef } from './channels';
import { channelFiles, ensureStateDir, openSessionDir, writeStateFile, type SessionFiles } from './state';

let root: string;
let files: SessionFiles;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-channels-'));
  files = await openSessionDir('claude', 'session', { XDG_STATE_HOME: root });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function channel(roomId: string, channelName?: string): Promise<ChannelRef> {
  const nested = channelFiles(files, roomId);
  await ensureStateDir(nested.dir);
  await writeStateFile(nested.dir, 'channel.json', { roomId, channelName, joinedAt: '2026-10-05T12:00:00.000Z' });
  return { key: channelKey(roomId), roomId, ...(channelName === undefined ? {} : { channelName }), files: nested, legacy: false };
}
it('uses stable Windows-safe 24 character keys', () => {
  expect(channelKey('!eco:khala.aiur.team')).toMatch(/^[a-f0-9]{24}$/);
  expect(channelKey('!eco:khala.aiur.team')).toBe(channelKey('!eco:khala.aiur.team'));
  expect(channelKey('!eco:khala.aiur.team')).not.toBe(channelKey('!other:khala.aiur.team'));
});
it('lists sorted channels and skips missing, corrupt and mismatched metadata', async () => {
  const z = await channel('!z:test', 'Zebra');
  const a = await channel('!a:test', 'Alpha');
  const bad = await channel('!bad:test');
  await fs.writeFile(path.join(bad.files.dir, 'channel.json'), '{');
  const missing = await channel('!missing:test');
  await fs.unlink(path.join(missing.files.dir, 'channel.json'));
  const tampered = await channel('!tampered:test');
  await writeStateFile(tampered.files.dir, 'channel.json', { roomId: a.roomId });
  expect(await listChannels(files)).toEqual([a, z]);
});
it('includes live legacy inboxes using root status and inbox fallback', async () => {
  await channel('!a:test', 'Alpha');
  await fs.writeFile(files.inbox, JSON.stringify({ roomId: '!eco:test' }) + '\n');
  await writeStateFile(files.dir, 'status.json', { channelName: 'Ecosystem' });
  expect((await listChannels(files))[1]).toEqual({ key: channelKey('!eco:test'), roomId: '!eco:test', channelName: 'Ecosystem', files, legacy: true });
  await writeStateFile(files.dir, 'session.json', { roomId: '!preferred:test' });
  expect((await listChannels(files))[1]?.roomId).toBe('!preferred:test');
});
it.each([true, false])('migrates bytes with credentials present: %s and preserves session-level state', async credentials => {
  const roomId = '!eco:test';
  if (credentials) await writeStateFile(files.dir, 'session.json', { roomId });
  const content = { 'cursor.json': '{ "deliveredCount": 7 }\n', 'mode.json': '{ "mode": "watch" }\n', 'inbox.jsonl': JSON.stringify({ roomId }) + '\n' };
  for (const [name, bytes] of Object.entries(content)) await fs.writeFile(path.join(files.dir, name), bytes);
  for (const name of ['rejoin.json', 'activity.json', 'watcher.json']) await fs.writeFile(path.join(files.dir, name), 'unchanged');
  expect(await migrateLegacy(files)).toBe('moved');
  for (const [name, bytes] of Object.entries(content)) expect(await fs.readFile(path.join(channelFiles(files, roomId).dir, name), 'utf8')).toBe(bytes);
  expect(JSON.parse(await fs.readFile(channelFiles(files, roomId).cursor, 'utf8')).deliveredCount).toBe(7);
  for (const name of ['rejoin.json', 'activity.json', 'watcher.json']) expect(await fs.readFile(path.join(files.dir, name), 'utf8')).toBe('unchanged');
  expect(await migrateLegacy(files)).toBe('none');
});
it('resumes after cursor has already moved', async () => {
  const nested = channelFiles(files, '!eco:test');
  await ensureStateDir(nested.dir);
  await fs.writeFile(nested.cursor, '{"deliveredCount":2}\n');
  await fs.writeFile(files.mode, '{}\n');
  await fs.writeFile(files.inbox, '{"roomId":"!eco:test"}\n');
  expect(await migrateLegacy(files)).toBe('moved');
  expect(await fs.readFile(nested.cursor, 'utf8')).toBe('{"deliveredCount":2}\n');
  expect((await listChannels(files))[0]?.roomId).toBe('!eco:test');
});
it('discards legacy files with no room id', async () => {
  for (const name of ['cursor.json', 'mode.json', 'inbox.jsonl']) await fs.writeFile(path.join(files.dir, name), '{}\n');
  expect(await migrateLegacy(files)).toBe('discarded');
  expect(await migrateLegacy(files)).toBe('none');
  expect(await fs.readdir(files.dir)).toEqual([]);
});
it('resolves omitted refs, normalized names, exact ids and ambiguity', async () => {
  const eco = await channel('!eco:test', 'Ecosystem');
  const other = await channel('!other:test', '!eco:test');
  const choices = [{ channel: 'Ecosystem', roomId: eco.roomId }, { channel: '!eco:test', roomId: other.roomId }];
  expect(resolveChannel([], undefined)).toEqual({ ok: false, code: 'channel_unknown', channels: [] });
  expect(resolveChannel([eco], undefined)).toEqual({ ok: true, channel: eco });
  expect(resolveChannel([eco, other], undefined)).toEqual({ ok: false, code: 'channel_required', channels: choices });
  for (const ref of ['#Ecosystem', 'ecosystem', '!eco:test']) expect(resolveChannel([eco, other], ref)).toEqual({ ok: true, channel: eco });
  expect(resolveChannel([eco], 'unknown')).toEqual({ ok: false, code: 'channel_unknown', channels: [choices[0]] });
  const general = [{ ...eco, channelName: 'General' }, { ...other, channelName: 'general' }];
  expect(resolveChannel(general, '#GENERAL')).toMatchObject({ ok: false, code: 'channel_ambiguous' });
  expect(resolveChannel([eco], '!ECO:test')).toMatchObject({ ok: false, code: 'channel_unknown' });
});

function entry(eventId: string) {
  return { eventId, roomId: '!eco:test', ts: '2026-10-05T12:00:00.000Z', sender: '@human:test', senderLabel: 'Human', senderKind: 'human' as const, kind: 'message' as const, body: eventId };
}
it.each([false, true])('merges only legacy unread entries without replacing channel history (root cursor: %s)', async withCursor => {
  const nested = (await channel('!eco:test')).files;
  const cursorBytes = '{ "lastDeliveredEventId": "$channel-delivered", "deliveredCount": 1 }\n';
  const modeBytes = '{ "mode": "watch" }\n';
  await appendEntries(nested, [entry('$channel-delivered'), entry('$overlap')]);
  await fs.writeFile(nested.cursor, cursorBytes);
  await fs.writeFile(nested.mode, modeBytes);
  await appendEntries(files, [...(withCursor ? [entry('$root-delivered')] : []), entry('$overlap'), entry('$new')]);
  if (withCursor) await writeStateFile(files.dir, 'cursor.json', { lastDeliveredEventId: '$root-delivered', deliveredCount: 1 });
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' });
  expect(await migrateLegacy(files)).toBe('moved');
  expect((await readEntries(nested)).map(e => e.eventId)).toEqual(['$channel-delivered', '$overlap', '$new']);
  expect((await unread(nested)).entries.map(e => e.eventId)).toEqual(['$overlap', '$new']);
  expect(await fs.readFile(nested.cursor, 'utf8')).toBe(cursorBytes);
  expect(await fs.readFile(nested.mode, 'utf8')).toBe(modeBytes);
  expect(await migrateLegacy(files)).toBe('none');
  // Simulate a crash after append: deduplication makes retry harmless.
  await appendEntries(files, [entry('$overlap'), entry('$new')]);
  expect(await migrateLegacy(files)).toBe('moved');
  expect((await readEntries(nested)).map(e => e.eventId)).toEqual(['$channel-delivered', '$overlap', '$new']);
  // Simulate a crash after removing the inbox but before root cursor/mode cleanup.
  await writeStateFile(files.dir, 'session.json', { roomId: '!eco:test' });
  await writeStateFile(files.dir, 'cursor.json', { lastDeliveredEventId: '$stale', deliveredCount: 20 });
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' });
  expect(await migrateLegacy(files)).toBe('moved');
  expect(await fs.readFile(nested.cursor, 'utf8')).toBe(cursorBytes);
  expect(await fs.readFile(nested.mode, 'utf8')).toBe(modeBytes);
});

it.each([[1, 5], [5, 1], [0, 2], [2, 2]])('migrates conflicting cursors safely (legacy %s, channel %s)', async (legacy, channelCount) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const nested = (await channel('!eco:test')).files;
  const entries = Array.from({ length: 6 }, (_, index) => entry(`$${index}`));
  await appendEntries(files, entries);
  await writeStateFile(files.dir, 'cursor.json', { lastDeliveredEventId: '$legacy', deliveredCount: legacy });
  await writeStateFile(nested.dir, 'cursor.json', { lastDeliveredEventId: '$channel', deliveredCount: channelCount });
  await writeStateFile(nested.dir, 'mode.json', { mode: 'watch' });
  expect(await migrateLegacy(files)).toBe('moved');
  expect((await unread(nested)).entries).toEqual(entries.slice(Math.min(legacy, channelCount)));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(`using earlier position ${Math.min(legacy, channelCount)} to avoid skipping messages`));
  warning.mockRestore();
  expect(JSON.parse(await fs.readFile(nested.mode, 'utf8'))).toEqual({ mode: 'watch' });
  expect(await migrateLegacy(files)).toBe('none');
});
it('preserves an existing mode while completing an interrupted cursor rename', async () => {
  const nested = (await channel('!eco:test')).files;
  await appendEntries(files, [entry('$delivered'), entry('$unread')]);
  await writeStateFile(nested.dir, 'cursor.json', { lastDeliveredEventId: '$delivered', deliveredCount: 1 });
  await writeStateFile(nested.dir, 'mode.json', { mode: 'watch' });
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' });
  const bytes = await fs.readFile(files.inbox, 'utf8');
  expect(await migrateLegacy(files)).toBe('moved');
  expect(await fs.readFile(nested.inbox, 'utf8')).toBe(bytes);
  expect((await unread(nested)).entries.map(e => e.eventId)).toEqual(['$unread']);
  expect(JSON.parse(await fs.readFile(nested.mode, 'utf8'))).toEqual({ mode: 'watch' });
});

it('migrates legacy cursor and mode byte-identically even before an inbox exists', async () => {
  const nested = channelFiles(files, '!eco:test');
  await writeStateFile(files.dir, 'session.json', { roomId: '!eco:test' });
  const cursorBytes = '{ "lastDeliveredEventId": null, "deliveredCount": 0 }\n';
  const modeBytes = '{ "mode": "async" }\n';
  await fs.writeFile(files.cursor, cursorBytes);
  await fs.writeFile(files.mode, modeBytes);
  expect(await migrateLegacy(files)).toBe('moved');
  expect(await fs.readFile(nested.cursor, 'utf8')).toBe(cursorBytes);
  expect(await fs.readFile(nested.mode, 'utf8')).toBe(modeBytes);
  await expect(fs.access(nested.inbox)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await migrateLegacy(files)).toBe('none');
});
