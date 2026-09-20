// Opens the owner connector's durable application state: exclusive, owner-only, schema
// checked. The selected messaging SDK keeps its own crypto store; this ledger never
// opens, wraps or migrates it, and no operation here is atomic with an SDK write.

import { DatabaseSync } from 'node:sqlite';
import type { DeliveryLimits, DeviceId } from '@khala/contracts/delivery/index';
import { StorageError, toStorageError } from './errors';
import {
  type ConnectorLedger, type CursorResult, type LedgerContext, type PersistInput, type PersistResult, type QuarantineEntry,
  type UnavailableInput, type UnavailableResult, commitCursor, createLedgerTx, persistPending, persistUnavailable,
  readCursor, readQuarantine, readReleasedPayload, requireIdentifier, resolveQuarantine, runTransaction,
} from './ledger';
import {
  type OpenMode, acquireExclusiveLock, assertOpenedFile, claimEpoch, pinLedgerFile, prepareStatePath,
} from './leases';
import { newPayloadRef } from './payloads';
import { prepareSchema } from './schema';

export type ConnectorStorageOptions = Readonly<{
  /** Absolute, owner-only state directory. Created 0700 in `create` mode. */
  directory: string;
  /**
   * `create` initialises an absent store (first bootstrap only). Every later start
   * uses `existing`, so lost state is `missing_state`, never a silent fresh identity.
   */
  mode: OpenMode;
  limits: DeliveryLimits;
  /**
   * Optional cap on the ledger's size, at least MIN_MAX_BYTES; writes past it fail
   * with `storage_full`.
   */
  maxBytes?: number;
}>;

export type DeviceIdentity = Readonly<{ deviceId: DeviceId; fingerprint: string }>;

/** Smallest accepted `maxBytes`: room for the schema and a few maximal payloads. */
export const MIN_MAX_BYTES = 256 * 1024;

export type IdentityResult =
  | Readonly<{ kind: 'bound' | 'matched' }>
  /**
   * `identity_mismatch`: a different device or fingerprint is already bound.
   * `identity_unbound`: an `existing` ledger that already holds state has no bound
   * identity, so nothing proves this device created it. Either way the handle is
   * blocked: every later call fails with `identity_mismatch` until it is closed.
   */
  | Readonly<{ kind: 'conflict'; code: 'identity_mismatch' | 'identity_unbound' }>;

export interface ConnectorStorage {
  /**
   * Durably records a decrypted event for review before its cursor may advance. A
   * decrypted event replaces an unavailable placeholder with the same key and
   * attribution (`replaced`).
   */
  persistPending(input: PersistInput): Promise<PersistResult>;
  /**
   * Durably records an event that could not be decrypted or authenticated, so the
   * cursor can move past it without losing it. Never replaces a decrypted record.
   */
  persistUnavailable(input: UnavailableInput): Promise<UnavailableResult>;
  readCursor(streamId: string): Promise<Readonly<{ revision: number; opaqueCursor: string }> | null>;
  /** Blocked while a conflict quarantined on the same stream is unresolved. */
  commitCursor(input: { streamId: string; expectedRevision: number; opaqueCursor: string }): Promise<CursorResult>;
  /** One page of quarantined conflicts with `id > afterId` (at most MAX_QUARANTINE_PAGE). */
  readQuarantine(input?: { afterId?: number; limit?: number }): Promise<readonly QuarantineEntry[]>;
  resolveQuarantine(input: { id: number; resolvedAt: string }): Promise<ReturnType<typeof resolveQuarantine>>;
  /** Resolves an opaque handle only while a release references it. */
  readReleasedPayload(payloadRef: string): Promise<Uint8Array>;
  /**
   * Binds this ledger to the SDK device it was created with. A different device or
   * key fingerprint later is refused rather than adopted as a replacement identity.
   */
  bindDeviceIdentity(identity: DeviceIdentity): Promise<IdentityResult>;
  readonly ledger: ConnectorLedger;
  /** The open epoch this handle owns; each open increments it. */
  readonly epoch: number;
  close(): Promise<void>;
}

/** @internal Exposes the underlying connection to recovery in this directory. */
export const storageInternals = new WeakMap<ConnectorStorage, {
  ctx: LedgerContext;
  isOpen: () => boolean;
  assertUsable: () => void;
}>();

export async function openConnectorStorage(options: ConnectorStorageOptions): Promise<ConnectorStorage> {
  const { maxBytes } = options;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MAX_BYTES)) {
    throw new StorageError('invalid_input');
  }
  const file = prepareStatePath(options.directory, options.mode);
  const identity = pinLedgerFile(file);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    throw toStorageError(error);
  }

  let epoch: number;
  let hadState: boolean;
  try {
    acquireExclusiveLock(db);
    assertOpenedFile(file, identity);
    db.exec('PRAGMA foreign_keys = ON');
    if (maxBytes !== undefined) {
      const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(maxBytes / pageSize))}`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      prepareSchema(db, options.mode);
      hadState = holdsState(db);
      epoch = claimEpoch(db);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.close();
    throw toStorageError(error);
  }

  const ctx: LedgerContext = { db, epoch, limits: options.limits };
  let open = true;
  let identityBlocked = false;
  const guard = () => {
    if (!open) throw new StorageError('closed');
    if (identityBlocked) throw new StorageError('identity_mismatch');
  };

  const storage: ConnectorStorage = {
    epoch,

    async persistPending(input) {
      guard();
      if (input.plaintext?.byteLength > options.limits.maxPayloadBytes) throw new StorageError('limit_exceeded');
      return persistPending(ctx, input, newPayloadRef);
    },

    async persistUnavailable(input) {
      guard();
      return persistUnavailable(ctx, input);
    },

    async readCursor(streamId) {
      guard();
      return readCursor(db, streamId);
    },

    async commitCursor(input) {
      guard();
      return commitCursor(ctx, input);
    },

    async readQuarantine(input) {
      guard();
      return readQuarantine(db, input);
    },

    async resolveQuarantine(input) {
      guard();
      return resolveQuarantine(ctx, input);
    },

    async readReleasedPayload(payloadRef) {
      guard();
      return readReleasedPayload(ctx, payloadRef);
    },

    async bindDeviceIdentity(identity) {
      guard();
      const deviceId = requireIdentifier(identity.deviceId);
      const fingerprint = requireIdentifier(identity.fingerprint);
      const value = JSON.stringify({ deviceId, fingerprint });
      const result = runTransaction(ctx, (): IdentityResult => {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'device_identity'").get() as { value: string } | undefined;
        if (row !== undefined) return row.value === value ? { kind: 'matched' } : { kind: 'conflict', code: 'identity_mismatch' };
        // Binding is first-bootstrap only. Existing state with no bound identity may
        // belong to another device; adopting it would substitute an identity silently.
        if (options.mode === 'existing' && hadState) return { kind: 'conflict', code: 'identity_unbound' };
        db.prepare("INSERT INTO meta (key, value) VALUES ('device_identity', ?)").run(value);
        return { kind: 'bound' };
      });
      if (result.kind === 'conflict') identityBlocked = true;
      return result;
    },

    ledger: {
      async transaction(run) {
        guard();
        let live = true;
        const { tx, failed } = createLedgerTx(ctx, () => live && open);
        try {
          return runTransaction(ctx, () => run(tx), () => !failed());
        } finally {
          live = false;
        }
      },
    },

    async close() {
      if (!open) return;
      open = false;
      // Closing the connection releases the exclusive lock.
      db.close();
    },
  };
  storageInternals.set(storage, { ctx, isOpen: () => open, assertUsable: guard });
  return storage;
}

/** Whether the ledger held anything before this open claimed its epoch. */
function holdsState(db: DatabaseSync): boolean {
  const revision = db.prepare("SELECT value FROM meta WHERE key = 'ledger_revision'").get() as { value: string };
  if (Number(revision.value) > 0) return true;
  return db.prepare('SELECT 1 FROM cursors LIMIT 1').get() !== undefined;
}
