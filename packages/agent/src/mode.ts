import { decodeListeningMode, DEFAULT_LISTENING_MODE, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import path from 'node:path';
import { advanceCursor, markNudged, readCursor, readEntries, unread } from './inbox';
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
 * agent owns (its live lease), behaves as `mute`, so nothing wakes the session or delivers frames. */
export async function readListeningMode(files: SessionFiles): Promise<ListeningMode> {
  const state = await readModeState(files);
  return state.archived || await isDelegated(files) ? 'mute' : state.mode;
}
/** Mirrors the owner's archive flag; the stored mode is kept for unarchive. Like leaving a quiet mode, unarchiving skips the backlog. */
export async function applyArchived(files: SessionFiles, archived: boolean): Promise<void> {
  const content = await readJson<Record<string, unknown>>(files.mode);
  if ((content?.archived === true) === archived) return;
  const stored = (await readModeState(files)).mode;
  if (!archived && !QUIET.has(stored)) await skipBacklog(files);
  if (!archived && stored === 'async') await skipPings(files);
  await writeJsonAtomic(files.mode, { ...(content ?? {}), archived });
}
/** Pings that arrived while muted (or archived) were ignored; they must not nudge once async resumes. */
async function skipPings(files: SessionFiles): Promise<void> {
  const cursor = await readCursor(files);
  await markNudged(files, cursor, (await readEntries(files)).length);
}
async function skipBacklog(files: SessionFiles): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cursor, entries } = await unread(files);
    if (await advanceCursor(files, cursor, entries) !== 'conflict') return;
  }
  throw new StateError('storage_failed');
}
/** Attention order for agent self-changes: a `self` change may only move down this scale. */
export const ATTENTION: Readonly<Record<ListeningMode, number>> = { mute: 0, async: 1, sync: 2, steer: 3 };
/** Modes that never deliver frames, so their backlog builds up behind the cursor. */
const QUIET: ReadonlySet<ListeningMode> = new Set(['async', 'mute']);
/** An agent change records `eventTs` (its own time) so a replayed older owner command cannot undo it.
 * Leaving a quiet mode (`async`, `mute`) skips the queued backlog unless `keepBacklog` is set. */
export async function applyListeningMode(files: SessionFiles, next: ListeningMode,
  meta: ({ changedBy: 'owner'; eventId: string } | { changedBy: 'agent'; reason: string; eventId?: string }) & { eventTs?: number; pendingPublish?: true; keepBacklog?: boolean },
  now: () => Date = () => new Date()) {
  const { keepBacklog, ...record } = meta;
  const { mode: previous, archived } = await readModeState(files);
  if (QUIET.has(previous) && !QUIET.has(next) && !keepBacklog) await skipBacklog(files);
  if (previous === 'mute' && next === 'async') await skipPings(files);
  await writeJsonAtomic(files.mode, { mode: next, ...(archived ? { archived } : {}), ...record, updatedAt: now().toISOString() });
  return { previous, next };
}
