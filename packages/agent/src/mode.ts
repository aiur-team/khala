import { decodeListeningMode, DEFAULT_LISTENING_MODE, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import { advanceCursor, unread } from './inbox';
import { readJson, StateError, writeJsonAtomic, type SessionFiles } from './state';

export async function readListeningMode(files: SessionFiles): Promise<ListeningMode> {
  const content = await readJson<unknown>(files.mode);
  const decoded = decodeListeningMode(typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>).mode : undefined);
  return decoded.ok ? decoded.value : DEFAULT_LISTENING_MODE;
}
export async function applyListeningMode(files: SessionFiles, next: ListeningMode,
  meta: { changedBy: 'owner'; eventId: string; eventTs?: number; pendingPublish?: true }, now: () => Date = () => new Date()) {
  const previous = await readListeningMode(files);
  if (previous === 'async' && next !== 'async') {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { cursor, entries } = await unread(files);
      if (await advanceCursor(files, cursor, entries) !== 'conflict') break;
      if (attempt === 1) throw new StateError('storage_failed');
    }
  }
  await writeJsonAtomic(files.mode, { mode: next, ...meta, updatedAt: now().toISOString() });
  return { previous, next };
}
