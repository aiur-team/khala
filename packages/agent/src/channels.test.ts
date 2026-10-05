import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
