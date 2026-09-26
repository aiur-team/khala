// Durable channel-access activation journal (RD5B) over the owner connector's
// already-open ledger. Like bootstrap rows, activation rows do not advance the
// application ledger revision. The X25519 recovery private key lives in its own
// column in the owner-only state directory; it is never part of the record JSON,
// never returned outside `load`, and never logged.

import {
  type ActivationRead,
  type ActivationRecord,
  type ActivationWrite,
  type ChannelAccessActivationStore,
  type RecoveryKeyWrite,
  decodeActivationRecord,
} from '../bootstrap/channel-access-activation';
import { StorageError } from './errors';
import { requireIdentifier, runTransaction } from './ledger';
import { type ConnectorStorage, storageInternals } from './open';

const RECOVERY_KEY_BYTES = 32;

type Row = { revision: number; phase: string; record: string; recovery_key: Uint8Array | null };

function context(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals) throw new StorageError('closed');
  internals.assertUsable();
  return internals.ctx;
}

function parse(row: Row, operationId: string): ActivationRecord {
  let record: ActivationRecord | null;
  try {
    record = decodeActivationRecord(JSON.parse(row.record));
  } catch {
    throw new StorageError('corrupt');
  }
  if (record === null || record.operationId !== operationId || record.phase !== row.phase || row.revision < 1) {
    throw new StorageError('corrupt');
  }
  if (row.recovery_key !== null && row.recovery_key.length !== RECOVERY_KEY_BYTES) throw new StorageError('corrupt');
  return record;
}

/** A real SQLite-backed `ChannelAccessActivationStore`. */
export function createChannelAccessActivationStore(storage: ConnectorStorage): ChannelAccessActivationStore {
  return {
    async load(operationId): Promise<ActivationRead> {
      const id = requireIdentifier(operationId);
      const ctx = context(storage);
      return runTransaction(ctx, () => {
        const row = ctx.db.prepare(`SELECT revision, phase, record, recovery_key FROM channel_access_activations
          WHERE operation_id = ?`).get(id) as Row | undefined;
        if (!row) return { kind: 'absent' };
        const record = parse(row, id);
        const recoveryKey = row.recovery_key === null ? null : new Uint8Array(row.recovery_key);
        return { kind: 'record', record, revision: row.revision, recoveryKey };
      });
    },

    async save(input: ActivationRecord, expectedRevision: number | null, key: RecoveryKeyWrite): Promise<ActivationWrite> {
      const record = decodeActivationRecord(JSON.parse(JSON.stringify(input)));
      if (record === null) throw new StorageError('invalid_input');
      if (key.kind === 'set' && key.privateKey.length !== RECOVERY_KEY_BYTES) throw new StorageError('invalid_input');
      const ctx = context(storage);
      return runTransaction(ctx, () => {
        const row = ctx.db.prepare(`SELECT revision, phase, record, recovery_key FROM channel_access_activations
          WHERE operation_id = ?`).get(record.operationId) as Row | undefined;
        const recoveryKey = key.kind === 'set' ? Buffer.from(key.privateKey) : key.kind === 'clear' ? null : row?.recovery_key ?? null;
        if (row === undefined) {
          if (expectedRevision !== null) return { kind: 'conflict' };
          ctx.db.prepare(`INSERT INTO channel_access_activations (operation_id, revision, phase, record, recovery_key)
            VALUES (?, 1, ?, ?, ?)`).run(record.operationId, record.phase, JSON.stringify(record), recoveryKey);
          return { kind: 'saved', revision: 1 };
        }
        const current = parse(row, record.operationId);
        // The request tuple and the reserved device never change under one operation.
        if (row.revision !== expectedRevision || current.requester !== record.requester || current.origin !== record.origin
          || current.sessionGeneration !== record.sessionGeneration || current.proofKeyThumbprint !== record.proofKeyThumbprint
          || (current.deviceId !== null && current.deviceId !== record.deviceId)) {
          return { kind: 'conflict' };
        }
        const revision = row.revision + 1;
        ctx.db.prepare(`UPDATE channel_access_activations SET revision = ?, phase = ?, record = ?, recovery_key = ?
          WHERE operation_id = ?`).run(revision, record.phase, JSON.stringify(record), recoveryKey, record.operationId);
        return { kind: 'saved', revision };
      });
    },

    async listActive(): Promise<readonly string[]> {
      const ctx = context(storage);
      return runTransaction(ctx, () => (ctx.db.prepare(`SELECT operation_id FROM channel_access_activations
        WHERE phase NOT IN ('connected', 'closed') ORDER BY operation_id`).all() as { operation_id: string }[])
        .map(row => row.operation_id));
    },
  };
}
