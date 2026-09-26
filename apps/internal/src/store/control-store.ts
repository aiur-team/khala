import { randomBytes } from 'node:crypto';
import {
  type CompareAndSetInput, type ControlRecord, type ControlStore, type JsonValue, type TrustedClock, isRecordLive,
  sameJsonValue,
} from '@khala/contracts/messaging/index';
import type { InternalStoreHandle } from './open';

// `ControlStore` over the channel store's SQLite file, for the shared
// channel-access journal, grant exchange and grant issuer. Every write is one
// immediate transaction. An operation ID is claimed with the exact record it
// produced, so a retry with identical bytes replays and any other reuse is an
// `operation_mismatch`. Expired records read as absent.

type RecordRow = Readonly<{
  record_key: string;
  revision: string;
  operation_id: string;
  value: string;
  expires_at: string | null;
}>;

function toRecord<T extends JsonValue>(row: RecordRow): ControlRecord<T> {
  return {
    key: row.record_key,
    revision: row.revision,
    operationId: row.operation_id,
    value: JSON.parse(row.value) as T,
    expiresAt: row.expires_at,
  };
}

export function createSqliteControlStore(handle: InternalStoreHandle, clock: TrustedClock): ControlStore {
  const live = (row: RecordRow | undefined): RecordRow | undefined =>
    row && isRecordLive({ expiresAt: row.expires_at }, clock()) ? row : undefined;

  return {
    async read<T extends JsonValue>(key: string) {
      try {
        const row = handle.read(db => db.prepare('SELECT * FROM control_records WHERE record_key = ?').get(key) as RecordRow | undefined);
        const current = live(row);
        return current ? { kind: 'record' as const, record: toRecord<T>(current) } : { kind: 'absent' as const };
      } catch {
        return { kind: 'unavailable' as const };
      }
    },

    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      let text: string;
      try {
        text = JSON.stringify(input.next.value);
      } catch {
        return { kind: 'unavailable' as const };
      }
      try {
        return handle.transaction(db => {
          const claimed = db.prepare('SELECT * FROM control_operations WHERE operation_id = ?')
            .get(input.operationId) as RecordRow | undefined;
          if (claimed) {
            return claimed.record_key === input.key && claimed.expires_at === input.next.expiresAt
              && sameJsonValue(JSON.parse(claimed.value) as JsonValue, input.next.value)
              ? { kind: 'applied' as const, record: toRecord<T>(claimed) }
              : { kind: 'operation_mismatch' as const };
          }
          const current = live(db.prepare('SELECT * FROM control_records WHERE record_key = ?').get(input.key) as RecordRow | undefined);
          if ((current?.revision ?? null) !== input.expectedRevision) {
            return { kind: 'conflict' as const, current: current ? toRecord<T>(current) : null };
          }
          const row: RecordRow = {
            record_key: input.key,
            revision: `crev_${randomBytes(16).toString('base64url')}`,
            operation_id: input.operationId,
            value: text,
            expires_at: input.next.expiresAt,
          };
          db.prepare(`
            INSERT INTO control_records (record_key, revision, operation_id, value, expires_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (record_key) DO UPDATE SET
              revision = excluded.revision, operation_id = excluded.operation_id,
              value = excluded.value, expires_at = excluded.expires_at
          `).run(row.record_key, row.revision, row.operation_id, row.value, row.expires_at);
          db.prepare(`
            INSERT INTO control_operations (operation_id, record_key, revision, value, expires_at) VALUES (?, ?, ?, ?, ?)
          `).run(row.operation_id, row.record_key, row.revision, row.value, row.expires_at);
          return { kind: 'applied' as const, record: toRecord<T>(row) };
        });
      } catch {
        // A failed commit may still have landed; the caller resolves by operation ID.
        return { kind: 'outcome_unknown' as const, operationId: input.operationId };
      }
    },

    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      try {
        const claimed = handle.read(db => db.prepare('SELECT * FROM control_operations WHERE operation_id = ?')
          .get(input.operationId) as RecordRow | undefined);
        return claimed?.record_key === input.key
          ? { kind: 'applied' as const, record: toRecord<T>(claimed) }
          : { kind: 'not_applied' as const };
      } catch {
        return { kind: 'unavailable' as const };
      }
    },
  };
}
