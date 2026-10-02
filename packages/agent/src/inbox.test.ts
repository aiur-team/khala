import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { openSessionDir, writeJsonAtomic, type SessionFiles } from './state';
import { advanceCursor, appendEntries, appendInbox, readCursor, readEntries, unread, unreadCount, unreadCounts } from './inbox';

let root: string;
let files: SessionFiles;
const entry = (id: string, kind: InboxEntry['kind'] = 'message'): InboxEntry => ({ eventId: id, roomId: '!r:khala.local', ts: '2026-10-02T10:04:00.000Z', sender: '@maya:khala.local', senderLabel: 'Maya', senderKind: 'human', kind, body: 'Docs are a go from my side.' });
const e1 = entry('$e1'), e2 = entry('$e2'), e3 = entry('$e3');
const initial = { lastDeliveredEventId: null, deliveredCount: 0 };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-inbox-'));
  files = await openSessionDir('claude', 'session-1', { XDG_STATE_HOME: root });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('reads absent inbox and cursor as empty', async () => {
  expect(await readEntries(files)).toEqual([]);
  expect(await readCursor(files)).toEqual(initial);
  expect(await unread(files)).toEqual({ entries: [], cursor: initial });
});
it('deduplicates within and across batches without rewriting the inbox', async () => {
  expect(await appendEntries(files, [e1, e2, e1])).toEqual([e1, e2]);
  const original = await fs.readFile(files.inbox, 'utf8');
  expect(original).toBe(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
  expect(await appendEntries(files, [e2])).toEqual([]);
  expect(await fs.readFile(files.inbox, 'utf8')).toBe(original);
  expect((await fs.stat(files.inbox)).mode & 0o777).toBe(0o600);
});
it('separates total unread entries from messages for both APIs', async () => {
  const event = entry('$event', 'event');
  await appendEntries(files, [e1, event, e2]);
  expect(await unread(files)).toEqual({ entries: [e1, event, e2], cursor: initial });
  expect(await unreadCounts(files)).toEqual({ total: 3, messages: 2 });
  expect(await unreadCount(files.dir)).toEqual({ total: 3, messages: 2 });
  await advanceCursor(files, initial, [e1]);
  expect(await unreadCount(files.dir)).toEqual({ total: 2, messages: 1 });
});
it('advances the cursor atomically and rejects stale or mismatched delivery', async () => {
  await appendEntries(files, [e1, e2]);
  expect(await advanceCursor(files, initial, [e2])).toBe('conflict');
  expect(await advanceCursor(files, initial, [e1, e2, e3])).toBe('conflict');
  const next = { lastDeliveredEventId: '$e2', deliveredCount: 2 };
  expect(await advanceCursor(files, initial, [e1, e2])).toEqual(next);
  const saved = await fs.readFile(files.cursor, 'utf8');
  expect(saved).toBe(JSON.stringify(next) + '\n');
  expect((await fs.stat(files.cursor)).mode & 0o777).toBe(0o600);
  expect(await advanceCursor(files, initial, [e1, e2])).toBe('conflict');
  expect(await advanceCursor(files, { ...next, lastDeliveredEventId: '$other' }, [])).toBe('conflict');
  expect(await fs.readFile(files.cursor, 'utf8')).toBe(saved);
  expect(await unread(files)).toEqual({ entries: [], cursor: next });
});
it('keeps an append during delivery unread exactly once', async () => {
  await appendEntries(files, [e1, e2]);
  const delivery = await unread(files);
  await appendEntries(files, [e3]);
  expect(await advanceCursor(files, delivery.cursor, delivery.entries)).toEqual({ lastDeliveredEventId: '$e2', deliveredCount: 2 });
  expect((await unread(files)).entries).toEqual([e3]);
  await advanceCursor(files, (await unread(files)).cursor, [e3]);
  expect((await unread(files)).entries).toEqual([]);
});
it('ignores partial tails, malformed JSON and invalid shapes', async () => {
  const invalid = [null, [], {}, { ...e1, body: 5 }, { ...e1, senderKind: 'robot' }, { ...e1, kind: 'other' }];
  await fs.writeFile(files.inbox, JSON.stringify(e1) + '\n{\n' + invalid.map(value => JSON.stringify(value) + '\n').join('') + JSON.stringify(e2) + '\n' + JSON.stringify(e3));
  expect(await readEntries(files)).toEqual([e1, e2]);
  await fs.appendFile(files.inbox, '\n');
  expect(await readEntries(files)).toEqual([e1, e2, e3]);
});
it.each([null, {}, { ...initial, deliveredCount: -1 }, { ...initial, deliveredCount: 0.5 }, { ...initial, deliveredCount: '2' }, { ...initial, lastDeliveredEventId: 5 }])('defaults invalid cursor %j', async value => {
  await writeJsonAtomic(files.cursor, value);
  expect(await readCursor(files)).toEqual(initial);
});
it('defaults malformed cursor JSON and clamps an oversized count', async () => {
  await fs.writeFile(files.cursor, '{');
  expect(await readCursor(files)).toEqual(initial);
  await appendEntries(files, [e1, e2]);
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: '$e2', deliveredCount: 99 });
  expect((await unread(files)).entries).toEqual([]);
});
it('leaves the cursor absent on empty delivery', async () => {
  expect(await advanceCursor(files, initial, [])).toEqual(initial);
  expect(await fs.readdir(files.dir)).toEqual([]);
});
it('wraps append and count APIs for directory consumers', async () => {
  expect(await appendInbox(files.dir, e1)).toBe(true);
  expect(await appendInbox(files.dir, e1)).toBe(false);
  expect(await unreadCount(files.dir)).toEqual({ total: 1, messages: 1 });
});
