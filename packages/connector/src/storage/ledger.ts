// The owner connector's application ledger: pending review items, replay cursors,
// recipient bindings, the approval command journal, releases and delivery receipts.
//
// Consumers (KHA-121/130/133/134/135) get a transaction-scoped port, not SQL. A
// transaction callback is synchronous local SQLite work only: no SDK, network, model
// or harness call can happen inside it, and a callback that returns a promise is
// rolled back. Errors roll the whole transaction back. When a commit's outcome is
// uncertain, reopen and read back the operation identity instead of retrying blind.

import type { DatabaseSync } from 'node:sqlite';
import {
  type ApprovalResult, type BindingId, type CommandId, type DeliveryLimits, type DeliveryReceipt, type EventId,
  type EventRef, type OwnerId, type ReleaseId, type ReleasedJob, type RoomId, type SessionBinding,
  type UnverifiedReleasedJob, decodeDeliveryReceipt, decodeEventRef, decodeReleasedJob, decodeSessionBinding,
  sameEventRef, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { StorageError, toStorageError } from './errors';
import { assertEpoch } from './leases';
import { insertPayload, payloadExists, payloadReferences, readPayload, sha256Digest } from './payloads';

/** Local uniqueness is the event and its immutable recipient, never content alone. */
export type PendingKey = Readonly<{
  roomId: RoomId;
  eventId: EventId;
  recipientBindingId: BindingId;
  recipientGeneration: number;
}>;

export type PersistConflictCode =
  /** The same event identity arrived again with a different content digest. */
  | 'event_digest_mismatch'
  /** Same identity and digest, different attribution. */
  | 'event_ref_mismatch'
  /** The plaintext does not hash to the reference's content digest. */
  | 'content_digest_mismatch';

export type PersistResult =
  | Readonly<{ kind: 'inserted' | 'duplicate' }>
  | Readonly<{ kind: 'conflict'; code: PersistConflictCode }>;

export type CursorResult =
  | Readonly<{ kind: 'committed'; revision: number }>
  | Readonly<{ kind: 'conflict'; code: 'stale_revision'; revision: number }>
  /** A quarantined conflict must be resolved before replay position may advance. */
  | Readonly<{ kind: 'blocked'; code: 'quarantine_unresolved' }>;

/** Immutable event reference, exact content bytes and recipient, stored together. */
export type PendingRecord = Readonly<{
  key: PendingKey;
  event: EventRef;
  content: Uint8Array;
  receivedAt: string;
  ledgerRevision: number;
}>;

/**
 * One idempotent approval: owner + command ID, the digest of its canonical input and
 * the committed result, so a retry replays the result and a changed input is refused.
 */
export type CommandRecord = Readonly<{
  ownerId: OwnerId;
  commandId: CommandId;
  inputDigest: string;
  result: ApprovalResult;
}>;

export type BindingResult =
  | Readonly<{ kind: 'inserted' | 'advanced' | 'duplicate' }>
  | Readonly<{ kind: 'conflict'; code: 'stale_generation' | 'binding_mismatch' }>;

export type ReleaseConflictCode =
  | 'idempotency_conflict'
  | 'stale_ledger'
  | 'invalid_command_result'
  | 'stale_binding'
  | 'pending_missing'
  | 'stale_content'
  | 'payload_digest_mismatch'
  | 'limit_exceeded'
  | 'release_conflict';

export type ReleaseResult =
  | Readonly<{ kind: 'committed' | 'duplicate' }>
  | Readonly<{ kind: 'conflict'; code: ReleaseConflictCode }>;

export type ReceiptResult =
  | Readonly<{ kind: 'recorded' | 'duplicate' }>
  /**
   * `unknown_release` and `correlation_mismatch` are still recorded for
   * reconciliation; `receipt_conflict` (same ID, different fact) is not.
   */
  | Readonly<{ kind: 'conflict'; code: 'receipt_conflict' | 'unknown_release' | 'correlation_mismatch' }>;

export type StoredRelease = Readonly<{
  ownerId: OwnerId;
  commandId: CommandId;
  job: UnverifiedReleasedJob;
  ledgerRevision: number;
}>;

export interface LedgerTx {
  /** One consistent snapshot for pure approval evaluation (KHA-119). */
  readApprovalSnapshot(input: { bindingId: BindingId; selection: readonly EventRef[] }): Readonly<{
    binding: SessionBinding;
    /** Records for the binding's current generation, in selection order; absent ones are omitted. */
    pending: readonly PendingRecord[];
    ledgerRevision: number;
  }> | null;
  readBinding(bindingId: BindingId): SessionBinding | null;
  /** Records a binding or advances it to a later generation; never rewinds. */
  putBinding(binding: SessionBinding): BindingResult;
  readCommand(ownerId: OwnerId, commandId: CommandId): CommandRecord | null;
  /** Writes the command outcome, release payload and released job together, or nothing. */
  putRelease(input: {
    command: CommandRecord;
    job: ReleasedJob;
    payload: Uint8Array;
    expectedLedgerRevision: number;
  }): ReleaseResult;
  readRelease(releaseId: ReleaseId): StoredRelease | null;
  appendReceipt(input: { receipt: DeliveryReceipt }): ReceiptResult;
  readReceipts(releaseId: ReleaseId): readonly DeliveryReceipt[];
  /** Live references to a payload handle; retention (KHA-130) owns deletion policy. */
  readPayloadReferences(payloadRef: string): Readonly<{ pending: number; releases: number }>;
  ledgerRevision(): number;
}

export interface ConnectorLedger {
  transaction<T>(run: (tx: LedgerTx) => T): Promise<T>;
}

export type LedgerContext = Readonly<{
  db: DatabaseSync;
  epoch: number;
  limits: DeliveryLimits;
}>;

// ---------------------------------------------------------------------------------
// Transactions

let depth = 0;

/**
 * Runs `run` in one IMMEDIATE transaction after re-checking the open epoch. The
 * callback must be synchronous. SQLite failures surface as StorageError; anything the
 * callback throws propagates unchanged after rollback.
 */
export function runTransaction<T>(ctx: LedgerContext, run: () => T): T {
  if (depth > 0) throw new StorageError('nested_transaction');
  const { db } = ctx;
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    throw toStorageError(error);
  }
  depth += 1;
  try {
    assertEpoch(db, ctx.epoch);
    const result = run();
    if (typeof (result as { then?: unknown } | null)?.then === 'function') throw new StorageError('async_transaction');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* the connection reports the original failure */ }
    }
    throw (error as { errcode?: unknown } | null)?.errcode !== undefined ? toStorageError(error) : error;
  } finally {
    depth -= 1;
  }
}

function readRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'ledger_revision'").get() as { value: string };
  return Number(row.value);
}

function bumpRevision(db: DatabaseSync): number {
  const next = readRevision(db) + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'ledger_revision'").run(String(next));
  return next;
}

function parseOrCorrupt<T>(json: string, decode: (input: unknown) => { ok: boolean; value?: T }): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new StorageError('corrupt');
  }
  const decoded = decode(value);
  if (!decoded.ok) throw new StorageError('corrupt');
  return decoded.value as T;
}

// ---------------------------------------------------------------------------------
// Pending items, quarantine and cursors (used by ConnectorStorage)

type PendingRow = {
  room_id: string;
  event_id: string;
  binding_id: string;
  generation: number;
  event_ref: string;
  payload_ref: string;
  received_at: string;
  ledger_revision: number;
};

function toPendingRecord(db: DatabaseSync, row: PendingRow): PendingRecord {
  const content = readPayload(db, row.payload_ref);
  if (content === null) throw new StorageError('corrupt');
  return {
    key: {
      roomId: row.room_id as RoomId,
      eventId: row.event_id as EventId,
      recipientBindingId: row.binding_id as BindingId,
      recipientGeneration: row.generation,
    },
    event: parseOrCorrupt(row.event_ref, decodeEventRef),
    content,
    receivedAt: row.received_at,
    ledgerRevision: row.ledger_revision,
  };
}

/** Records a conflict once; replaying the same conflicting event does not grow the table. */
function quarantine(db: DatabaseSync, key: PendingKey, code: PersistConflictCode, digest: string, at: string): void {
  const seen = db.prepare(`SELECT 1 FROM quarantine WHERE room_id = ? AND event_id = ? AND binding_id = ? AND generation = ?
    AND code = ? AND observed_digest = ?`).get(key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, code, digest);
  if (seen !== undefined) return;
  db.prepare(`INSERT INTO quarantine (room_id, event_id, binding_id, generation, code, observed_digest, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, code, digest, at);
}

export function persistPending(
  ctx: LedgerContext,
  input: { key: PendingKey; event: EventRef; plaintext: Uint8Array; receivedAt: string },
  newPayloadRef: () => string,
): PersistResult {
  const { key, event, plaintext, receivedAt } = input;
  if (key.roomId !== event.roomId || key.eventId !== event.eventId) throw new TypeError('pending key does not name its event');
  const { db } = ctx;
  return runTransaction(ctx, () => {
    const observed = sha256Digest(plaintext);
    if (observed !== event.contentDigest) {
      quarantine(db, key, 'content_digest_mismatch', observed, receivedAt);
      bumpRevision(db);
      return { kind: 'conflict', code: 'content_digest_mismatch' } as const;
    }

    // Any stored copy of this event, for any recipient, must be the same immutable
    // reference. Approved content is never overwritten.
    const stored = db.prepare('SELECT event_ref FROM pending WHERE room_id = ? AND event_id = ?')
      .all(key.roomId, key.eventId) as { event_ref: string }[];
    for (const row of stored) {
      const existing = parseOrCorrupt(row.event_ref, decodeEventRef);
      if (sameEventRef(existing, event)) continue;
      const code = existing.contentDigest !== event.contentDigest ? 'event_digest_mismatch' : 'event_ref_mismatch';
      quarantine(db, key, code, event.contentDigest, receivedAt);
      bumpRevision(db);
      return { kind: 'conflict', code } as const;
    }

    const exists = db.prepare('SELECT 1 FROM pending WHERE room_id = ? AND event_id = ? AND binding_id = ? AND generation = ?')
      .get(key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration);
    if (exists !== undefined) return { kind: 'duplicate' } as const;

    const payloadRef = newPayloadRef();
    insertPayload(db, payloadRef, plaintext);
    const revision = bumpRevision(db);
    db.prepare(`INSERT INTO pending (room_id, event_id, binding_id, generation, event_ref, content_digest, payload_ref,
      received_at, ledger_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, JSON.stringify(event),
      event.contentDigest, payloadRef, receivedAt, revision,
    );
    return { kind: 'inserted' } as const;
  });
}

export function readCursor(db: DatabaseSync, streamId: string): { revision: number; opaqueCursor: string } | null {
  const row = db.prepare('SELECT revision, opaque_cursor FROM cursors WHERE stream_id = ?').get(streamId) as
    | { revision: number; opaque_cursor: string }
    | undefined;
  return row ? { revision: row.revision, opaqueCursor: row.opaque_cursor } : null;
}

/** Compare-and-set; an absent cursor has revision 0. */
export function commitCursor(
  ctx: LedgerContext,
  input: { streamId: string; expectedRevision: number; opaqueCursor: string },
): CursorResult {
  const { db } = ctx;
  return runTransaction(ctx, () => {
    const unresolved = db.prepare('SELECT 1 FROM quarantine LIMIT 1').get();
    if (unresolved !== undefined) return { kind: 'blocked', code: 'quarantine_unresolved' } as const;
    const current = readCursor(db, input.streamId)?.revision ?? 0;
    if (current !== input.expectedRevision) return { kind: 'conflict', code: 'stale_revision', revision: current } as const;
    const revision = current + 1;
    db.prepare(`INSERT INTO cursors (stream_id, revision, opaque_cursor) VALUES (?, ?, ?)
      ON CONFLICT (stream_id) DO UPDATE SET revision = excluded.revision, opaque_cursor = excluded.opaque_cursor`)
      .run(input.streamId, revision, input.opaqueCursor);
    return { kind: 'committed', revision } as const;
  });
}

/** Released payload bytes, only while a release references the handle. */
export function readReleasedPayload(ctx: LedgerContext, payloadRef: string): Uint8Array {
  const { db } = ctx;
  const referenced = db.prepare('SELECT 1 FROM releases WHERE payload_ref = ?').get(payloadRef);
  const bytes = referenced === undefined ? null : readPayload(db, payloadRef);
  if (bytes === null) throw new StorageError('payload_unavailable');
  return bytes;
}

// ---------------------------------------------------------------------------------
// Transaction-scoped port

export function createLedgerTx(ctx: LedgerContext, isLive: () => boolean): LedgerTx {
  const { db, limits } = ctx;
  const live = () => {
    if (!isLive()) throw new StorageError('closed');
  };

  const readBinding = (bindingId: BindingId): SessionBinding | null => {
    const row = db.prepare('SELECT binding FROM bindings WHERE binding_id = ?').get(bindingId) as { binding: string } | undefined;
    return row ? parseOrCorrupt(row.binding, decodeSessionBinding) : null;
  };

  const readPendingAt = (event: EventRef, binding: SessionBinding): PendingRecord | null => {
    const row = db.prepare(`SELECT * FROM pending WHERE room_id = ? AND event_id = ? AND binding_id = ? AND generation = ?`)
      .get(event.roomId, event.eventId, binding.bindingId, binding.generation) as PendingRow | undefined;
    return row ? toPendingRecord(db, row) : null;
  };

  const readCommand = (ownerId: OwnerId, commandId: CommandId): CommandRecord | null => {
    const row = db.prepare('SELECT input_digest, result FROM commands WHERE owner_id = ? AND command_id = ?')
      .get(ownerId, commandId) as { input_digest: string; result: string } | undefined;
    if (!row) return null;
    return { ownerId, commandId, inputDigest: row.input_digest, result: JSON.parse(row.result) as ApprovalResult };
  };

  const readRelease = (releaseId: ReleaseId): StoredRelease | null => {
    const row = db.prepare('SELECT owner_id, command_id, job, ledger_revision FROM releases WHERE release_id = ?')
      .get(releaseId) as { owner_id: string; command_id: string; job: string; ledger_revision: number } | undefined;
    if (!row) return null;
    return {
      ownerId: row.owner_id as OwnerId,
      commandId: row.command_id as CommandId,
      job: parseOrCorrupt(row.job, input => decodeReleasedJob(input, limits)),
      ledgerRevision: row.ledger_revision,
    };
  };

  return {
    readApprovalSnapshot({ bindingId, selection }) {
      live();
      const binding = readBinding(bindingId);
      if (binding === null) return null;
      const pending = selection.flatMap(event => {
        const record = readPendingAt(event, binding);
        return record ? [record] : [];
      });
      return { binding, pending, ledgerRevision: readRevision(db) };
    },

    readBinding(bindingId) {
      live();
      return readBinding(bindingId);
    },

    putBinding(binding) {
      live();
      const stored = readBinding(binding.bindingId);
      if (stored !== null) {
        if (sameSessionBinding(stored, binding)) return { kind: 'duplicate' };
        if (binding.generation <= stored.generation) {
          return { kind: 'conflict', code: binding.generation < stored.generation ? 'stale_generation' : 'binding_mismatch' };
        }
        // A new generation may move the session or device, never the owner or agent.
        if (binding.ownerId !== stored.ownerId || binding.agentParticipantId !== stored.agentParticipantId) {
          return { kind: 'conflict', code: 'binding_mismatch' };
        }
      }
      db.prepare(`INSERT INTO bindings (binding_id, generation, binding) VALUES (?, ?, ?)
        ON CONFLICT (binding_id) DO UPDATE SET generation = excluded.generation, binding = excluded.binding`)
        .run(binding.bindingId, binding.generation, JSON.stringify(binding));
      bumpRevision(db);
      return { kind: stored === null ? 'inserted' : 'advanced' };
    },

    readCommand(ownerId, commandId) {
      live();
      return readCommand(ownerId, commandId);
    },

    putRelease({ command, job, payload, expectedLedgerRevision }) {
      live();
      const existing = readCommand(command.ownerId, command.commandId);
      if (existing !== null) {
        const stored = readRelease(job.releaseId);
        const same = existing.inputDigest === command.inputDigest
          && stored !== null
          && stored.commandId === command.commandId
          && stored.job.payloadDigest === job.payloadDigest;
        return same ? { kind: 'duplicate' } : { kind: 'conflict', code: 'idempotency_conflict' };
      }
      if (readRevision(db) !== expectedLedgerRevision) return { kind: 'conflict', code: 'stale_ledger' };

      const { result } = command;
      if (!result.ok || result.releaseIds.length !== 1 || result.releaseIds[0] !== job.releaseId) {
        return { kind: 'conflict', code: 'invalid_command_result' };
      }
      const binding = readBinding(job.binding.bindingId);
      if (binding === null || !sameSessionBinding(binding, job.binding)) return { kind: 'conflict', code: 'stale_binding' };
      for (const event of job.events) {
        const record = readPendingAt(event, binding);
        if (record === null) return { kind: 'conflict', code: 'pending_missing' };
        if (!sameEventRef(record.event, event)) return { kind: 'conflict', code: 'stale_content' };
      }
      if (payload.byteLength > limits.maxPayloadBytes) return { kind: 'conflict', code: 'limit_exceeded' };
      if (sha256Digest(payload) !== job.payloadDigest) return { kind: 'conflict', code: 'payload_digest_mismatch' };
      if (readRelease(job.releaseId) !== null || payloadExists(db, job.payloadRef)) {
        return { kind: 'conflict', code: 'release_conflict' };
      }

      const revision = bumpRevision(db);
      db.prepare('INSERT INTO commands (owner_id, command_id, input_digest, result) VALUES (?, ?, ?, ?)')
        .run(command.ownerId, command.commandId, command.inputDigest, JSON.stringify(result));
      insertPayload(db, job.payloadRef, payload);
      db.prepare(`INSERT INTO releases (release_id, owner_id, command_id, payload_ref, job, ledger_revision)
        VALUES (?, ?, ?, ?, ?, ?)`).run(job.releaseId, command.ownerId, command.commandId, job.payloadRef, JSON.stringify(job), revision);
      return { kind: 'committed' };
    },

    readRelease(releaseId) {
      live();
      return readRelease(releaseId);
    },

    appendReceipt({ receipt }) {
      live();
      const stored = db.prepare('SELECT receipt FROM receipts WHERE receipt_id = ?').get(receipt.receiptId) as
        | { receipt: string }
        | undefined;
      const json = JSON.stringify(receipt);
      if (stored !== undefined) {
        return stored.receipt === json ? { kind: 'duplicate' } : { kind: 'conflict', code: 'receipt_conflict' };
      }
      const release = readRelease(receipt.releaseId);
      const correlation = release === null
        ? 'unknown_release'
        : release.job.binding.bindingId !== receipt.bindingId || release.job.binding.generation !== receipt.generation
          ? 'correlation_mismatch'
          : 'correlated';
      const revision = bumpRevision(db);
      db.prepare('INSERT INTO receipts (receipt_id, release_id, correlation, receipt, ledger_revision) VALUES (?, ?, ?, ?, ?)')
        .run(receipt.receiptId, receipt.releaseId, correlation, json, revision);
      return correlation === 'correlated' ? { kind: 'recorded' } : { kind: 'conflict', code: correlation };
    },

    readReceipts(releaseId) {
      live();
      const rows = db.prepare('SELECT receipt FROM receipts WHERE release_id = ? ORDER BY ledger_revision')
        .all(releaseId) as { receipt: string }[];
      return rows.map(row => parseOrCorrupt(row.receipt, decodeDeliveryReceipt));
    },

    readPayloadReferences(payloadRef) {
      live();
      return payloadReferences(db, payloadRef);
    },

    ledgerRevision() {
      live();
      return readRevision(db);
    },
  };
}
