// Post-restart inspection of the application ledger. Recovery reports; it never
// repairs by guessing. Old-generation records stay preserved and are not adopted by a
// newer binding, quarantined conflicts keep replay blocked, and a release without a
// terminal receipt is reported by what is known about it: a release with any dispatch
// evidence has an unknown outcome and must never be resubmitted; only a release with no
// dispatch evidence at all is undispatched. Storage authorises neither. Evidence comes
// from both the `receipts` table and the dispatcher's own `dispatch_records`, whose state
// and receipts never reach `receipts`.

import type { BindingId, ReleaseId, ReceiptKindV2 } from '@khala/contracts/delivery/index';
import type { DatabaseSync } from 'node:sqlite';
import type { DispatchState } from '../dispatch/types';
import { StorageError, toStorageError } from './errors';
import { readEpoch } from './leases';
import { type ConnectorStorage, storageInternals } from './open';
import { sha256Digest } from './payloads';
import { SCHEMA_VERSION } from './schema';

export type RecoveryBlocker =
  /** SQLite's own consistency check failed. */
  | 'integrity_failed'
  /** Stored bytes no longer match their recorded digest. */
  | 'payload_damaged'
  /** An unresolved event conflict is quarantined; its stream cannot advance until it is resolved. */
  | 'quarantine_unresolved'
  /** A binding, or the device it delivers through, is revoked. */
  | 'revoked';

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
  /**
   * No terminal receipt, but some evidence (from any receipt for the release, correlated
   * or not, or from the dispatcher's record) that dispatch began. The harness may have
   * acted: never resubmit these.
   */
  outcomeUnknownReleases: readonly ReleaseId[];
  /** No terminal receipt and no dispatch evidence of any kind. */
  undispatchedReleases: readonly ReleaseId[];
  /** Unreplaced placeholders for events that could not be decrypted or authenticated. */
  unavailable: number;
  /** Bindings that are revoked, at any generation, or whose device is revoked. */
  revokedBindings: readonly BindingId[];
  /** Receipts kept for reconciliation that did not match a known release. */
  uncorrelatedReceipts: number;
  cursors: readonly Readonly<{ streamId: string; revision: number }>[];
  blocked: readonly RecoveryBlocker[];
}>;

const TERMINAL_RECEIPTS: readonly ReceiptKindV2[] = ['completed', 'failed', 'cancelled'];
/** Any of these proves dispatch progressed beyond a merely queued local release. */
const DISPATCH_EVIDENCE: readonly ReceiptKindV2[] = [
  'dispatching', 'transport_written', 'harness_queued', 'context_consumed', 'outcome_unknown', 'agent_acknowledged',
];
/** Dispatcher states reached only after the dispatch intent was persisted, still unsettled. */
const DISPATCHED_STATES: readonly DispatchState[] = ['dispatching', 'accepted', 'outcome_unknown'];
/**
 * Dispatcher states that settle a release. `queued`, `claimed`, `quarantined` and `rejected`
 * ran no effect, so they are neither dispatch evidence nor terminal.
 */
const SETTLED_STATES: readonly DispatchState[] = ['completed', 'failed', 'cancelled', 'abandoned'];
const sqlList = (kinds: readonly string[]) => kinds.map(kind => `'${kind}'`).join(', ');

const count = (value: unknown): number => (value as { n: number }).n;

/**
 * Inspects the ledger after a restart. A damaged structure that `quick_check` finds is
 * reported as `integrity_failed`; damage that stops the report itself from being read
 * fails with `corrupt`.
 */
export async function recoverConnectorStorage(storage: ConnectorStorage): Promise<RecoveryReport> {
  const internals = storageInternals.get(storage);
  if (!internals) throw new StorageError('closed');
  internals.assertUsable();
  try {
    return inspect(internals.ctx.db);
  } catch (error) {
    const mapped = toStorageError(error);
    throw mapped.code === 'io_failed' ? mapped : new StorageError('corrupt', mapped.sqliteCode);
  }
}

function inspect(db: DatabaseSync): RecoveryReport {

  const blocked: RecoveryBlocker[] = [];
  let check: { quick_check: string }[];
  try {
    check = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
  } catch {
    check = [];
  }
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

  const revoked = (db.prepare(`SELECT b.binding_id FROM bindings b WHERE EXISTS (SELECT 1 FROM revocations v WHERE
      (v.target_kind = 'binding' AND v.target_id = b.binding_id)
      OR (v.target_kind = 'device' AND v.target_id = json_extract(b.binding, '$.deviceId')))
    ORDER BY b.binding_id`).all() as { binding_id: string }[]).map(row => row.binding_id as BindingId);
  if (revoked.length > 0) blocked.push('revoked');

  const open = db.prepare(`SELECT release_id,
      EXISTS (SELECT 1 FROM receipts c WHERE c.release_id = r.release_id
        AND json_extract(c.receipt, '$.kind') IN (${sqlList(DISPATCH_EVIDENCE)}))
      OR EXISTS (SELECT 1 FROM dispatch_records d WHERE d.release_id = r.release_id
        AND d.state IN (${sqlList(DISPATCHED_STATES)})) AS dispatched
    FROM releases r WHERE NOT EXISTS (
      SELECT 1 FROM receipts c WHERE c.release_id = r.release_id AND c.correlation = 'correlated'
        AND json_extract(c.receipt, '$.kind') IN (${sqlList(TERMINAL_RECEIPTS)}))
      AND NOT EXISTS (SELECT 1 FROM dispatch_records d WHERE d.release_id = r.release_id
        AND d.state IN (${sqlList(SETTLED_STATES)}))
    ORDER BY ledger_revision`).all() as { release_id: string; dispatched: number }[];

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
    outcomeUnknownReleases: open.filter(row => row.dispatched === 1).map(row => row.release_id as ReleaseId),
    undispatchedReleases: open.filter(row => row.dispatched !== 1).map(row => row.release_id as ReleaseId),
    unavailable: count(db.prepare('SELECT count(*) AS n FROM unavailable WHERE replaced_revision IS NULL').get()),
    revokedBindings: revoked,
    uncorrelatedReceipts: count(db.prepare("SELECT count(*) AS n FROM receipts WHERE correlation <> 'correlated'").get()),
    cursors: (db.prepare('SELECT stream_id, revision FROM cursors ORDER BY stream_id').all() as {
      stream_id: string;
      revision: number;
    }[]).map(row => ({ streamId: row.stream_id, revision: row.revision })),
    blocked,
  };
}
