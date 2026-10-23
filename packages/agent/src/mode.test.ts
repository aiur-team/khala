import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as inbox from './inbox';
import { appendEntries, readCursor, unreadCounts } from './inbox';
import { filesForDir, type SessionFiles } from './state';
import { applyArchived, applyListeningMode, delegateChannel, isDelegated, readListeningMode, readModeState } from './mode';
let files: SessionFiles;
beforeEach(async () => { files = filesForDir(await fs.mkdtemp(path.join(os.tmpdir(), 'khala-mode-947-'))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(files.dir, { recursive: true, force: true }); });
const meta = { changedBy: 'owner' as const, eventId: '$mode' };
const now = () => new Date('2026-10-02T12:00:00.000Z');
it('defaults missing and invalid files to sync', async () => {
  expect(await readListeningMode(files)).toBe('sync');
  for (const content of ['broken', 'null', '{"mode":"loud"}']) {
    await fs.writeFile(files.mode, content); expect(await readListeningMode(files)).toBe('sync');
  }
});
it('a live delegation lease makes the session see mute, without changing the owner mode', async () => {
  await applyListeningMode(files, 'steer', meta);
  await delegateChannel(files, 60_000);
  expect(await readListeningMode(files)).toBe('mute');
  expect((await readModeState(files)).mode).toBe('steer');
  await delegateChannel(files, -1);
  expect(await isDelegated(files)).toBe(false);
  expect(await readListeningMode(files)).toBe('steer');
});
it('round trips mode and metadata', async () => {
  expect(await applyListeningMode(files, 'async', meta, now)).toEqual({ previous: 'sync', next: 'async' });
  expect(await readListeningMode(files)).toBe('async');
  expect(JSON.parse(await fs.readFile(files.mode, 'utf8'))).toEqual({ mode: 'async', ...meta, updatedAt: now().toISOString() });
});
async function backlog() {
  await appendEntries(files, [1, 2, 3].map(n => ({ eventId: '$' + n, roomId: '!r:s', ts: now().toISOString(), sender: '@h:s', senderLabel: 'Human', senderKind: 'human' as const, kind: 'message' as const, body: 'hello' })));
}
it.each(['sync', 'steer'] as const)('skips async backlog when switching to %s', async mode => {
  await applyListeningMode(files, 'async', meta); await backlog();
  await applyListeningMode(files, mode, meta);
  expect((await unreadCounts(files)).total).toBe(0);
});
it('leaves cursor unchanged from sync to steer', async () => {
  await backlog(); const cursor = await readCursor(files);
  await applyListeningMode(files, 'steer', meta);
  expect(await readCursor(files)).toEqual(cursor); expect((await unreadCounts(files)).total).toBe(3);
});

it('retries a cursor conflict once with a refreshed unread snapshot', async () => {
  await applyListeningMode(files, 'async', meta); await backlog();
  const advanceCursor = inbox.advanceCursor;
  const advance = vi.spyOn(inbox, 'advanceCursor').mockImplementationOnce(async (files, cursor, entries) => {
    await advanceCursor(files, cursor, entries.slice(0, 1));
    return 'conflict';
  });
  await applyListeningMode(files, 'sync', meta);
  expect(advance).toHaveBeenCalledTimes(2);
  expect(advance.mock.calls[1]![1].deliveredCount).toBe(1);
  expect((await unreadCounts(files)).total).toBe(0);
  expect(await readListeningMode(files)).toBe('sync');
});
it('preserves async after two cursor conflicts without a third attempt', async () => {
  await applyListeningMode(files, 'async', meta); await backlog();
  const advance = vi.spyOn(inbox, 'advanceCursor').mockResolvedValue('conflict');
  await expect(applyListeningMode(files, 'sync', meta)).rejects.toMatchObject({ code: 'storage_failed' });
  expect(advance).toHaveBeenCalledTimes(2); expect(await readListeningMode(files)).toBe('async');
  expect((await unreadCounts(files)).total).toBe(3);
});

it('archiving turns the channel mute and unarchiving restores the stored mode', async () => {
  await applyListeningMode(files, 'steer', meta, now);
  await applyArchived(files, true);
  expect(await readListeningMode(files)).toBe('mute');
  expect(await readModeState(files)).toEqual({ mode: 'steer', archived: true });
  await applyArchived(files, false);
  expect(await readListeningMode(files)).toBe('steer');
});
it('keeps the archive flag across an owner mode change without skipping backlog', async () => {
  await applyArchived(files, true); await backlog();
  await applyListeningMode(files, 'steer', meta, now);
  expect(await readModeState(files)).toEqual({ mode: 'steer', archived: true });
  expect((await unreadCounts(files)).total).toBe(3);
});
it('skips the archived-period backlog on unarchive, like leaving async', async () => {
  await applyArchived(files, true); await backlog();
  await applyArchived(files, false);
  expect((await unreadCounts(files)).total).toBe(0);
});
it('records an agent change with its reason and keeps the async backlog on request', async () => {
  await applyListeningMode(files, 'async', meta); await backlog();
  await applyListeningMode(files, 'sync', { changedBy: 'agent', reason: 'owner asked', eventTs: 5, keepBacklog: true }, now);
  expect((await unreadCounts(files)).total).toBe(3);
  expect(JSON.parse(await fs.readFile(files.mode, 'utf8'))).toEqual({ mode: 'sync', changedBy: 'agent', reason: 'owner asked', eventTs: 5, updatedAt: now().toISOString() });
});
