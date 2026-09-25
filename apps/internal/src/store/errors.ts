// Store failures expose finite codes only. SQLite messages and filesystem paths
// never cross the private storage boundary.

export const STORE_ERROR_CODES = [
  'unsafe_path',
  'missing_state',
  'locked',
  'corrupt',
  'schema_unsupported',
  'storage_full',
  'io_failed',
  'closed',
  'fenced',
  'transaction_aborted',
  'async_transaction',
  'nested_transaction',
] as const;

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly sqliteCode: number | null;

  constructor(code: StoreErrorCode, sqliteCode: number | null = null) {
    super(`internal store: ${code}`);
    this.name = 'StoreError';
    this.code = code;
    this.sqliteCode = sqliteCode;
  }
}

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

export function toStoreError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const sqliteCode = sqliteCodeOf(error);
  switch (sqliteCode === null ? null : sqliteCode & 0xff) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return new StoreError('locked', sqliteCode);
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return new StoreError('corrupt', sqliteCode);
    case SQLITE_FULL:
      return new StoreError('storage_full', sqliteCode);
    case SQLITE_READONLY:
    case SQLITE_IOERR:
    case SQLITE_CANTOPEN:
    default:
      return new StoreError('io_failed', sqliteCode);
  }
}
