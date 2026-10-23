import { decodeListeningMode, DEFAULT_LISTENING_MODE, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import { advanceCursor, unread } from './inbox';
import { readJson, StateError, writeJsonAtomic, type SessionFiles } from './state';

/** The owner-chosen mode and whether the owner archived the channel. */
export async function readModeState(files: SessionFiles): Promise<{ mode: ListeningMode; archived: boolean }> {
  const content = await readJson<unknown>(files.mode);
  const record = typeof content === 'object' && content !== null ? content as Record<string, unknown> : {};
  const decoded = decodeListeningMode(record.mode);
  return { mode: decoded.ok ? decoded.value : DEFAULT_LISTENING_MODE, archived: record.archived === true };
}
/** The effective mode: an archived channel behaves as `async`, so nothing wakes the agent or delivers frames. */
export async function readListeningMode(files: SessionFiles): Promise<ListeningMode> {
  const state = await readModeState(files);
  return state.archived ? 'async' : state.mode;
}
/** Mirrors the owner's archive flag; the stored mode is kept for unarchive. */
export async function applyArchived(files: SessionFiles, archived: boolean): Promise<void> {
  const content = await readJson<Record<string, unknown>>(files.mode);
  if ((content?.archived === true) === archived) return;
  await writeJsonAtomic(files.mode, { ...(content ?? {}), archived });
}
export async function applyListeningMode(files: SessionFiles, next: ListeningMode,
  meta: { changedBy: 'owner'; eventId: string; eventTs?: number; pendingPublish?: true }, now: () => Date = () => new Date()) {
  const { mode: previous, archived } = await readModeState(files);
  if (previous === 'async' && next !== 'async') {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { cursor, entries } = await unread(files);
      if (await advanceCursor(files, cursor, entries) !== 'conflict') break;
      if (attempt === 1) throw new StateError('storage_failed');
    }
  }
  await writeJsonAtomic(files.mode, { mode: next, ...(archived ? { archived } : {}), ...meta, updatedAt: now().toISOString() });
  return { previous, next };
}
