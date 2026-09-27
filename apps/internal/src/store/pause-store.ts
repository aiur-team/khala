import { randomBytes } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { InternalStoreHandle } from './open';

// The owner's pause of one binding generation, kept in the channel store's
// `control_records` table so it survives a launcher restart. The release feed
// reads it synchronously on every pull; a pause holds the whole feed behind its
// cursor, and resume releases the held work in order. A new generation starts
// unpaused, because a pause names the exact generation the owner saw.

export type BindingPauseKey = Pick<SessionBinding, 'bindingId' | 'generation'>;
export type BindingPauseRead = boolean | 'unavailable';

export type BindingPauseStore = Readonly<{
  read(binding: BindingPauseKey): BindingPauseRead;
  /** Idempotent: setting the current value again changes nothing. */
  set(binding: BindingPauseKey, paused: boolean): Readonly<{ kind: 'done'; paused: boolean }> | Readonly<{ kind: 'unavailable' }>;
}>;

type PauseRow = Readonly<{ value: string }>;

export function bindingPauseRecordKey(binding: BindingPauseKey): string {
  return `binding-pause:v1:${JSON.stringify([binding.bindingId, binding.generation])}`;
}

function pausedValue(row: PauseRow | undefined): boolean | null {
  if (row === undefined) return false;
  try {
    const value = JSON.parse(row.value) as unknown;
    return typeof value === 'object' && value !== null && typeof (value as { paused?: unknown }).paused === 'boolean'
      ? (value as { paused: boolean }).paused
      : null;
  } catch {
    return null;
  }
}

export function createBindingPauseStore(handle: InternalStoreHandle): BindingPauseStore {
  return {
    read(binding) {
      try {
        const row = handle.read(db => db.prepare('SELECT value FROM control_records WHERE record_key = ?')
          .get(bindingPauseRecordKey(binding)) as PauseRow | undefined);
        // A record this store cannot read fails closed: the feed is held, never released.
        return pausedValue(row) ?? 'unavailable';
      } catch {
        return 'unavailable';
      }
    },

    set(binding, paused) {
      const key = bindingPauseRecordKey(binding);
      const value = JSON.stringify({ paused });
      try {
        handle.transaction(db => {
          const revision = `crev_${randomBytes(16).toString('base64url')}`;
          const operationId = `pause_${randomBytes(16).toString('base64url')}`;
          db.prepare(`
            INSERT INTO control_records (record_key, revision, operation_id, value, expires_at) VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT (record_key) DO UPDATE SET
              revision = excluded.revision, operation_id = excluded.operation_id, value = excluded.value, expires_at = NULL
          `).run(key, revision, operationId, value);
        });
        return { kind: 'done', paused };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
