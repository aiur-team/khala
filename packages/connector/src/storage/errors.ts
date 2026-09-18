// Storage failures cross the owner endpoint as a closed code only. Messages are fixed
// strings: SQLite text, paths, payload bytes and keys never reach an error or a log.

export const STORAGE_ERROR_CODES = [
  'unsafe_path',
  'missing_state',
  'locked',
  'corrupt',
  'schema_unsupported',
  'storage_full',
  'io_failed',
  'closed',
  'fenced',
  'identity_mismatch',
  'payload_unavailable',
  'async_transaction',
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** Numeric SQLite result code when one caused this, for diagnosis without text. */
  readonly sqliteCode: number | null;

  constructor(code: StorageErrorCode, sqliteCode: number | null = null) {
    super(`connector storage: ${code}`);
    this.name = 'StorageError';
    this.code = code;
    this.sqliteCode = sqliteCode;
  }
}

// Primary SQLite result codes (the low byte of an extended code).
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

function sqliteCodeOf(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code : null;
}

/** Maps any thrown value to a StorageError without carrying its message along. */
export function toStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const sqliteCode = sqliteCodeOf(error);
  switch (sqliteCode === null ? null : sqliteCode & 0xff) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return new StorageError('locked', sqliteCode);
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return new StorageError('corrupt', sqliteCode);
    case SQLITE_FULL:
      return new StorageError('storage_full', sqliteCode);
    case SQLITE_READONLY:
    case SQLITE_IOERR:
    case SQLITE_CANTOPEN:
    default:
      return new StorageError('io_failed', sqliteCode);
  }
}
