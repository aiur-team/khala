import * as fs from 'node:fs/promises';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { isWakeEntry } from './events/receive';
import { filesForDir, readJson, StateError, writeJsonAtomic, type SessionFiles } from './state';

/** shownEventId: the newest entry whose content reached the agent's context (read receipts follow it, not nudges).
 * nudgedCount: async mentions before this index already earned their constant nudge. It is separate from
 * `deliveredCount` so a ping never moves the backlog cursor; a delivery past it drops it. */
export type Cursor = { lastDeliveredEventId: string | null; deliveredCount: number; shownEventId?: string; nudgedCount?: number };
export async function readEntries(files: SessionFiles): Promise<InboxEntry[]> {
  let content: string;
  try { content = await fs.readFile(files.inbox, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new StateError('storage_failed');
  }
  const entries: InboxEntry[] = [];
  for (const line of content.split('\n').slice(0, -1)) {
    try {
      const entry = JSON.parse(line);
      if (entry && ['eventId', 'roomId', 'ts', 'sender', 'senderLabel', 'body'].every(key => typeof entry[key] === 'string')
        && ['human', 'agent', 'unknown'].includes(entry.senderKind) && ['message', 'event'].includes(entry.kind)) entries.push(entry);
    } catch { /* Corrupt records do not prevent delivery of complete valid records. */ }
  }
  return entries;
}
export async function appendEntries(files: SessionFiles, entries: readonly InboxEntry[]): Promise<InboxEntry[]> {
  // KM-143 owns the single writer. Read/filter/append is not safe across multiple writers.
  const seen = new Set((await readEntries(files)).map(entry => entry.eventId));
  const fresh = entries.filter(entry => {
    if (seen.has(entry.eventId)) return false;
    seen.add(entry.eventId);
    return true;
  });
  if (fresh.length) {
    try { await fs.appendFile(files.inbox, fresh.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600, flag: 'a' }); }
    catch { throw new StateError('storage_failed'); }
  }
  return fresh;
}
export async function readCursor(files: SessionFiles): Promise<Cursor> {
  const cursor = await readJson<Cursor>(files.cursor);
  return cursor && (cursor.lastDeliveredEventId === null || typeof cursor.lastDeliveredEventId === 'string')
    && Number.isSafeInteger(cursor.deliveredCount) && cursor.deliveredCount >= 0
    ? cursor : { lastDeliveredEventId: null, deliveredCount: 0 };
}
export async function unread(files: SessionFiles): Promise<{ entries: InboxEntry[]; cursor: Cursor }> {
  const cursor = await readCursor(files);
  const entries = await readEntries(files);
  return { entries: entries.slice(cursor.deliveredCount), cursor };
}
/** Where wakes start counting: past the delivered cursor and past any mention that was already nudged. */
export function wakeStart(cursor: { deliveredCount: number; nudgedCount?: unknown }): number {
  return Math.max(cursor.deliveredCount, Number.isSafeInteger(cursor.nudgedCount) ? cursor.nudgedCount as number : 0);
}
/** Unread entries that may still wake the agent. */
export async function unwoken(files: SessionFiles): Promise<InboxEntry[]> {
  return (await readEntries(files)).slice(wakeStart(await readCursor(files)));
}
/** Records that entries up to `count` earned their nudge; the delivered cursor is left alone. A concurrent delivery wins. */
export async function markNudged(files: SessionFiles, expected: Cursor, count: number): Promise<void> {
  const current = await readCursor(files);
  if (current.deliveredCount !== expected.deliveredCount || current.lastDeliveredEventId !== expected.lastDeliveredEventId) return;
  await writeJsonAtomic(files.cursor, { ...current, nudgedCount: count });
}
export async function unreadCounts(files: SessionFiles): Promise<{ total: number; messages: number }> {
  const { entries } = await unread(files);
  return { total: entries.length, messages: entries.filter(entry => isWakeEntry(entry)).length };
}
export async function advanceCursor(files: SessionFiles, expected: Cursor, delivered: readonly InboxEntry[], shown = false): Promise<Cursor | 'conflict'> {
  const current = await readCursor(files);
  if (current.deliveredCount !== expected.deliveredCount || current.lastDeliveredEventId !== expected.lastDeliveredEventId) return 'conflict';
  if (!delivered.length) return expected;
  const entries = await readEntries(files);
  const slice = entries.slice(expected.deliveredCount, expected.deliveredCount + delivered.length);
  if (slice.length !== delivered.length || slice.some((entry, index) => entry.eventId !== delivered[index]?.eventId)) return 'conflict';
  const last = delivered[delivered.length - 1]!.eventId;
  const shownEventId = shown ? last : current.shownEventId;
  const next = { lastDeliveredEventId: last, deliveredCount: expected.deliveredCount + delivered.length, ...(shownEventId ? { shownEventId } : {}),
    ...(wakeStart(current) > expected.deliveredCount + delivered.length ? { nudgedCount: current.nudgedCount } : {}) };
  await writeJsonAtomic(files.cursor, next);
  return next;
}
export async function appendInbox(dir: string, entry: InboxEntry): Promise<boolean> { return (await appendEntries(filesForDir(dir), [entry])).length === 1; }
export function unreadCount(dir: string): Promise<{ total: number; messages: number }> { return unreadCounts(filesForDir(dir)); }
