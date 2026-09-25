import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { StoreError, toStoreError } from './errors';
import {
  type OpenMode, assertOpenedFile, prepareStorePath, secureStoreFiles,
} from './path';
import { type MigrationFault, prepareSchema, validateRawHeader } from './schema';

export type StoreNotification = Readonly<{
  kind: 'channel' | 'subscription';
  channelId: string;
}>;

export type StoreNotificationListener = (notification: StoreNotification) => void;

export interface InternalStoreHandle {
  /** Synchronous reads keep the single DatabaseSync private to the callback. */
  read<T>(run: (db: DatabaseSync) => T): T;
  /** One immediate transaction; Promise-returning callbacks are refused and rolled back. */
  transaction<T>(run: (db: DatabaseSync) => T): T;
  subscribe(listener: StoreNotificationListener): () => void;
  /** Repositories publish only after their transaction has definitely committed. */
  publish(notification: StoreNotification): void;
  /** Permanently prevents use after an indeterminate storage outcome. */
  fence(): void;
  close(): void;
}

export type OpenChannelStoreOptions = Readonly<{
  directory: string;
  mode: OpenMode;
  /** Test-only deterministic migration interruption seam. */
  migrationFault?: MigrationFault;
}>;

function acquireExclusiveOwnership(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // Acquire and retain EXCLUSIVE before WAL selection or any accepted mutation.
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (error) {
    throw toStoreError(error);
  }
}

function configureConnection(db: DatabaseSync): void {
  try {
    db.enableLoadExtension(false);
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    throw toStoreError(error);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

export function openChannelStore(options: OpenChannelStoreOptions): InternalStoreHandle {
  const prepared = prepareStorePath(options.directory, options.mode);
  if (prepared.header !== null) validateRawHeader(prepared.header);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(prepared.file, { allowExtension: false });
  } catch (error) {
    throw toStoreError(error);
  }

  try {
    acquireExclusiveOwnership(db);
    assertOpenedFile(prepared.file, prepared.identity);
    configureConnection(db);
    secureStoreFiles(prepared.file);
    db.exec('BEGIN IMMEDIATE');
    try {
      prepareSchema(db, options.mode, prepared.created, options.migrationFault);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (error instanceof StoreError) throw error;
      throw new StoreError('transaction_aborted');
    }
    // Establish identity/version in the main file before WAL can hold newer
    // header values. Concurrent openers can then reject or reach the lock
    // without needing SQLite to interpret an untrusted sidecar first.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    secureStoreFiles(prepared.file);
  } catch (error) {
    db.close();
    // A failed first create is intentionally left as an abandoned inode. A later
    // create cannot silently adopt it as a new database.
    throw toStoreError(error);
  }

  let state: 'open' | 'fenced' | 'closed' = 'open';
  let inTransaction = false;
  const listeners = new Set<StoreNotificationListener>();

  const guard = (): void => {
    if (state === 'closed') throw new StoreError('closed');
    if (state === 'fenced') throw new StoreError('fenced');
  };

  const handle: InternalStoreHandle = {
    read<T>(run: (database: DatabaseSync) => T): T {
      guard();
      return run(db);
    },

    transaction<T>(run: (database: DatabaseSync) => T): T {
      guard();
      if (inTransaction) throw new StoreError('nested_transaction');
      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = run(db);
        if (isPromiseLike(result)) throw new StoreError('async_transaction');
        try {
          db.exec('COMMIT');
        } catch (error) {
          state = 'fenced';
          throw toStoreError(error);
        }
        return result;
      } catch (error) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); } catch { state = 'fenced'; }
        }
        if (error instanceof StoreError) throw error;
        throw new StoreError('transaction_aborted');
      } finally {
        inTransaction = false;
      }
    },

    subscribe(listener) {
      guard();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    publish(notification) {
      guard();
      for (const listener of [...listeners]) {
        try { listener(notification); } catch {}
      }
    },

    fence() {
      if (state === 'open') state = 'fenced';
    },

    close() {
      if (state === 'closed') return;
      state = 'closed';
      listeners.clear();
      db.close();
      // SQLite can recreate companions with the process umask during shutdown.
      // Validate/chmod only files still linked from the accepted directory.
      secureStoreFiles(prepared.file);
    },
  };

  // Ensure the accepted main inode still exists before returning the owner.
  if (!fs.existsSync(prepared.file)) {
    handle.close();
    throw new StoreError('unsafe_path');
  }
  return handle;
}
