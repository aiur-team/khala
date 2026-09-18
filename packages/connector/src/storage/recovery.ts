// Post-restart inspection of the application ledger. Recovery reports; it never
// repairs by guessing. Old-generation records stay preserved and are not adopted by a
// newer binding, quarantined conflicts keep replay blocked, and a release without a
// terminal receipt is reported as unresolved: storage cannot authorise resubmission.

import type { ReleaseId, ReceiptKind } from '@khala/contracts/delivery/index';
import { StorageError } from './errors';
import { readEpoch } from './leases';
import { type ConnectorStorage, storageInternals } from './open';
import { sha256Digest } from './payloads';
import { SCHEMA_VERSION } from './schema';

export type RecoveryBlocker =
  /** SQLite's own consistency check failed. */
  | 'integrity_failed'
  /** Stored bytes no longer match their recorded digest. */
  | 'payload_damaged'
  /** An unresolved event conflict is quarantined; cursors cannot advance until it is resolved. */
  | 'quarantine_unresolved';

export type RecoveryReport = Readonly<{
  schemaVersion: number;
  epoch: number;
  ledgerRevision: number;
  deviceIdentityBound: boolean;
  pending: number;
  /** Pending records for a generation older than their binding's current one. */
  staleGenerationPending: number;
  /** Unresolved quarantine entries. */
  quarantined: number;
  /** Releases with no terminal receipt; their harness outcome may be unknown. */
  unresolvedReleases: readonly ReleaseId[];
  /** Receipts kept for reconciliation that did not match a known release. */
  uncorrelatedReceipts: number;
  cursors: readonly Readonly<{ streamId: string; revision: number }>[];
  blocked: readonly RecoveryBlocker[];
}>;

const TERMINAL_RECEIPTS: readonly ReceiptKind[] = ['completed', 'failed', 'cancelled'];

const count = (value: unknown): number => (value as { n: number }).n;

export async function recoverConnectorStorage(storage: ConnectorStorage): Promise<RecoveryReport> {
  const internals = storageInternals.get(storage);
  if (!internals || !internals.isOpen()) throw new StorageError('closed');
  const { db } = internals.ctx;

  const blocked: RecoveryBlocker[] = [];
  const check = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
  if (check.length !== 1 || check[0]!.quick_check !== 'ok') blocked.push('integrity_failed');

  const payloads = db.prepare('SELECT digest, bytes FROM payloads').iterate() as Iterable<{ digest: string; bytes: Uint8Array }>;
  for (const row of payloads) {
    if (sha256Digest(new Uint8Array(row.bytes)) !== row.digest) {
      blocked.push('payload_damaged');
      break;
    }
  }

  const quarantined = count(db.prepare('SELECT count(*) AS n FROM quarantine WHERE resolved_at IS NULL').get());
  if (quarantined > 0) blocked.push('quarantine_unresolved');

  const terminal = TERMINAL_RECEIPTS.map(kind => `'${kind}'`).join(', ');
  const unresolved = db.prepare(`SELECT release_id FROM releases r WHERE NOT EXISTS (
      SELECT 1 FROM receipts c WHERE c.release_id = r.release_id AND c.correlation = 'correlated'
        AND json_extract(c.receipt, '$.kind') IN (${terminal}))
    ORDER BY ledger_revision`).all() as { release_id: string }[];

  const revision = db.prepare("SELECT value FROM meta WHERE key = 'ledger_revision'").get() as { value: string };
  const identity = db.prepare("SELECT 1 FROM meta WHERE key = 'device_identity'").get();

  return {
    schemaVersion: SCHEMA_VERSION,
    epoch: readEpoch(db),
    ledgerRevision: Number(revision.value),
    deviceIdentityBound: identity !== undefined,
    pending: count(db.prepare('SELECT count(*) AS n FROM pending').get()),
    staleGenerationPending: count(db.prepare(`SELECT count(*) AS n FROM pending p JOIN bindings b
      ON b.binding_id = p.binding_id WHERE p.generation < b.generation`).get()),
    quarantined,
    unresolvedReleases: unresolved.map(row => row.release_id as ReleaseId),
    uncorrelatedReceipts: count(db.prepare("SELECT count(*) AS n FROM receipts WHERE correlation <> 'correlated'").get()),
    cursors: (db.prepare('SELECT stream_id, revision FROM cursors ORDER BY stream_id').all() as {
      stream_id: string;
      revision: number;
    }[]).map(row => ({ streamId: row.stream_id, revision: row.revision })),
    blocked,
  };
}
