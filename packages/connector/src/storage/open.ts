// Opens the owner connector's durable application state: exclusive, owner-only, schema
// checked. The selected messaging SDK keeps its own crypto store; this ledger never
// opens, wraps or migrates it, and no operation here is atomic with an SDK write.

import { DatabaseSync } from 'node:sqlite';
import type { DeliveryLimits, DeviceId, EventRef } from '@khala/contracts/delivery/index';
import { StorageError, toStorageError } from './errors';
import {
  type ConnectorLedger, type CursorResult, type LedgerContext, type PendingKey, type PersistResult,
  commitCursor, createLedgerTx, persistPending, readCursor, readReleasedPayload, runTransaction,
} from './ledger';
import { type OpenMode, acquireExclusiveLock, claimEpoch, prepareStatePath } from './leases';
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
  /** Optional cap on the ledger's size; writes past it fail with `storage_full`. */
  maxBytes?: number;
}>;

export type DeviceIdentity = Readonly<{ deviceId: DeviceId; fingerprint: string }>;

export type IdentityResult =
  | Readonly<{ kind: 'bound' | 'matched' }>
  | Readonly<{ kind: 'conflict'; code: 'identity_mismatch' }>;

export interface ConnectorStorage {
  /** Durably records a decrypted event for review before its cursor may advance. */
  persistPending(input: {
    key: PendingKey;
    event: EventRef;
    plaintext: Uint8Array;
    receivedAt: string;
  }): Promise<PersistResult>;
  readCursor(streamId: string): Promise<Readonly<{ revision: number; opaqueCursor: string }> | null>;
  commitCursor(input: { streamId: string; expectedRevision: number; opaqueCursor: string }): Promise<CursorResult>;
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
export const storageInternals = new WeakMap<ConnectorStorage, { ctx: LedgerContext; isOpen: () => boolean }>();

export async function openConnectorStorage(options: ConnectorStorageOptions): Promise<ConnectorStorage> {
  const file = prepareStatePath(options.directory, options.mode);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    throw toStorageError(error);
  }

  let epoch: number;
  try {
    acquireExclusiveLock(db);
    db.exec('PRAGMA foreign_keys = ON');
    if (options.maxBytes !== undefined) {
      const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(options.maxBytes / pageSize))}`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      prepareSchema(db);
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
  const guard = () => {
    if (!open) throw new StorageError('closed');
  };

  const storage: ConnectorStorage = {
    epoch,

    async persistPending(input) {
      guard();
      if (input.plaintext.byteLength > options.limits.maxPayloadBytes) throw new StorageError('limit_exceeded');
      return persistPending(ctx, input, newPayloadRef);
    },

    async readCursor(streamId) {
      guard();
      return readCursor(db, streamId);
    },

    async commitCursor(input) {
      guard();
      return commitCursor(ctx, input);
    },

    async readReleasedPayload(payloadRef) {
      guard();
      return readReleasedPayload(ctx, payloadRef);
    },

    async bindDeviceIdentity(identity) {
      guard();
      const value = JSON.stringify({ deviceId: identity.deviceId, fingerprint: identity.fingerprint });
      return runTransaction(ctx, () => {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'device_identity'").get() as { value: string } | undefined;
        if (row !== undefined) {
          return row.value === value ? { kind: 'matched' } as const : { kind: 'conflict', code: 'identity_mismatch' } as const;
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('device_identity', ?)").run(value);
        return { kind: 'bound' } as const;
      });
    },

    ledger: {
      async transaction(run) {
        guard();
        let live = true;
        const tx = createLedgerTx(ctx, () => live && open);
        try {
          return runTransaction(ctx, () => run(tx));
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
  storageInternals.set(storage, { ctx, isOpen: () => open });
  return storage;
}
