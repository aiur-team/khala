import { decodeListeningMode, DEFAULT_LISTENING_MODE, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import path from 'node:path';
import { advanceCursor, unread } from './inbox';
import { readJson, StateError, writeJsonAtomic, type SessionFiles } from './state';

/** The owner-chosen mode and whether the owner archived the channel. */
export async function readModeState(files: SessionFiles): Promise<{ mode: ListeningMode; archived: boolean }> {
  const content = await readJson<unknown>(files.mode);
  const record = typeof content === 'object' && content !== null ? content as Record<string, unknown> : {};
  const decoded = decodeListeningMode(record.mode);
  return { mode: decoded.ok ? decoded.value : DEFAULT_LISTENING_MODE, archived: record.archived === true };
}
const delegateFile = (files: SessionFiles) => path.join(files.dir, 'delegate.json');
/** A background agent waiting on this channel (khala_read wait) holds a lease until `ms` from now. */
export async function delegateChannel(files: SessionFiles, ms: number): Promise<void> {
  await writeJsonAtomic(delegateFile(files), { until: Date.now() + ms });
}
export async function isDelegated(files: SessionFiles): Promise<boolean> {
  const lease = await readJson<{ until?: unknown }>(delegateFile(files)).catch(() => null);
  return typeof lease?.until === 'number' && lease.until > Date.now();
}
/** The effective mode for the session's own hooks and wakes: an archived channel, or one a background
 * agent owns (its live lease), behaves as `async`, so nothing wakes the session or delivers frames. */
export async function readListeningMode(files: SessionFiles): Promise<ListeningMode> {
  const state = await readModeState(files);
  return state.archived || await isDelegated(files) ? 'async' : state.mode;
}
/** Mirrors the owner's archive flag; the stored mode is kept for unarchive. Like leaving `async`, unarchiving skips the backlog. */
export async function applyArchived(files: SessionFiles, archived: boolean): Promise<void> {
  const content = await readJson<Record<string, unknown>>(files.mode);
  if ((content?.archived === true) === archived) return;
  if (!archived && (await readModeState(files)).mode !== 'async') await skipBacklog(files);
  await writeJsonAtomic(files.mode, { ...(content ?? {}), archived });
}
async function skipBacklog(files: SessionFiles): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cursor, entries } = await unread(files);
    if (await advanceCursor(files, cursor, entries) !== 'conflict') return;
  }
  throw new StateError('storage_failed');
}
/** Attention order for agent self-changes: a `self` change may only move down this scale. A future
 * lower rung (the planned `mute`) gets its own number here; the Record type forces it when the mode set grows. */
export const ATTENTION: Readonly<Record<ListeningMode, number>> = { async: 0, sync: 1, steer: 2 };
/** An agent change records `eventTs` (its own time) so a replayed older owner command cannot undo it.
 * Leaving `async` skips the queued backlog unless `keepBacklog` is set. */
export async function applyListeningMode(files: SessionFiles, next: ListeningMode,
  meta: ({ changedBy: 'owner'; eventId: string } | { changedBy: 'agent'; reason: string; eventId?: string }) & { eventTs?: number; pendingPublish?: true; keepBacklog?: boolean },
  now: () => Date = () => new Date()) {
  const { keepBacklog, ...record } = meta;
  const { mode: previous, archived } = await readModeState(files);
  if (previous === 'async' && next !== 'async' && !keepBacklog) await skipBacklog(files);
  await writeJsonAtomic(files.mode, { mode: next, ...(archived ? { archived } : {}), ...record, updatedAt: now().toISOString() });
  return { previous, next };
}
