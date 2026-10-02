import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { appendEntries, readCursor, unreadCounts } from './inbox';
import { filesForDir, type SessionFiles } from './state';
import { applyListeningMode, readListeningMode } from './mode';
let files: SessionFiles;
beforeEach(async () => { files = filesForDir(await fs.mkdtemp(path.join(os.tmpdir(), 'khala-mode-947-'))); });
afterEach(async () => { await fs.rm(files.dir, { recursive: true, force: true }); });
const meta = { changedBy: 'owner' as const, eventId: '$mode' };
const now = () => new Date('2026-10-02T12:00:00.000Z');
it('defaults missing and invalid files to sync', async () => {
  expect(await readListeningMode(files)).toBe('sync');
  for (const content of ['broken', 'null', '{"mode":"loud"}']) {
    await fs.writeFile(files.mode, content); expect(await readListeningMode(files)).toBe('sync');
  }
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
