import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BindingId } from '@khala/contracts/delivery/index';
import type { TrustState } from '@khala/policy/trust/index';
import type { TrustStateStore } from './control-handler';

/** A separate owner-only SQLite journal, held under the connector's exclusive state lease. */
export async function openTrustStateStore(input: Readonly<{ directory: string; mode: 'create' | 'existing' }>): Promise<TrustStateStore & { close(): void }> {
  const file = path.join(input.directory, 'trust.sqlite');
  let fresh = false;
  try {
    const created = await open(file, 'wx', 0o600);
    await created.close();
    fresh = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || input.mode === 'create') throw error;
  }
  const existing = await lstat(file);
  if (!existing.isFile() || existing.mode & 0o077) throw new Error('trust_store_insecure');
  const db = new DatabaseSync(file);
  if (fresh) {
    db.exec(`PRAGMA application_id=0x4b484c41;
      CREATE TABLE trust (binding_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;`);
  } else {
    const marker = db.prepare('PRAGMA application_id').get() as { application_id: number };
    if (marker.application_id !== 0x4b484c41) { db.close(); throw new Error('trust_store_corrupt'); }
  }
  function decode(value: string): TrustState {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('trust_store_corrupt');
    const record = parsed as Record<string, unknown>;
    if (typeof record.bindingId !== 'string' || typeof record.ownerId !== 'string' || typeof record.roomId !== 'string'
      || !Number.isSafeInteger(record.generation) || !Array.isArray(record.journal)
      || !Array.isArray(record.listeningModeJournal) || typeof record.requested !== 'object') throw new Error('trust_store_corrupt');
    const journal = new Map(record.journal as [string, never][]);
    const listeningModeJournal = new Map(record.listeningModeJournal as [string, never][]);
    if (journal.size !== record.journal.length || listeningModeJournal.size !== record.listeningModeJournal.length) throw new Error('trust_store_corrupt');
    return { ...record, journal, listeningModeJournal } as unknown as TrustState;
  }
  function encode(state: TrustState): string {
    return JSON.stringify({ ...state, journal: [...state.journal], listeningModeJournal: [...state.listeningModeJournal] });
  }
  return {
    async read(bindingId: BindingId) {
      const row = db.prepare('SELECT state FROM trust WHERE binding_id = ?').get(bindingId) as { state: string } | undefined;
      if (!row) return null;
      const state = decode(row.state);
      if (state.bindingId !== bindingId) throw new Error('trust_store_corrupt');
      return state;
    },
    async update<T>(bindingId: BindingId, work: (current: TrustState | null) => Readonly<{ next: TrustState; result: T }>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT state FROM trust WHERE binding_id = ?').get(bindingId) as { state: string } | undefined;
        const current = row ? decode(row.state) : null;
        const { next, result } = work(current);
        if (next.bindingId !== bindingId) throw new Error('trust_store_binding_mismatch');
        db.prepare('INSERT INTO trust(binding_id,state) VALUES(?,?) ON CONFLICT(binding_id) DO UPDATE SET state=excluded.state')
          .run(bindingId, encode(next));
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
