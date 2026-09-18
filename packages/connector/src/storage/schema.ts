// The application ledger schema. It is owner-local SQLite and never touches the SDK's
// crypto store: the two commit separately, and nothing here assumes otherwise.

import type { DatabaseSync } from 'node:sqlite';
import { StorageError } from './errors';
import type { OpenMode } from './leases';

/** `PRAGMA application_id`: ASCII "KHLA", so a foreign SQLite file is refused. */
export const APPLICATION_ID = 0x4b484c41;
export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE payloads (
  payload_ref TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  bytes BLOB NOT NULL
) STRICT;

CREATE TABLE pending (
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  event_ref TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  payload_ref TEXT NOT NULL REFERENCES payloads (payload_ref),
  received_at TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  PRIMARY KEY (room_id, event_id, binding_id, generation)
) STRICT;
CREATE INDEX pending_event ON pending (room_id, event_id);

-- An event that could not be decrypted or authenticated, held so the cursor can pass it
-- without losing it. A later decrypted event with the same key and attribution replaces it.
CREATE TABLE unavailable (
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  event_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  replaced_revision INTEGER,
  PRIMARY KEY (room_id, event_id, binding_id, generation)
) STRICT;

-- A conflict blocks the cursor of the stream that observed it, until the owner resolves it.
CREATE TABLE quarantine (
  id INTEGER PRIMARY KEY,
  stream_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  code TEXT NOT NULL,
  observed_digest TEXT,
  observed_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE INDEX quarantine_stream ON quarantine (stream_id, resolved_at);

CREATE TABLE cursors (
  stream_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  opaque_cursor TEXT NOT NULL
) STRICT;

CREATE TABLE bindings (
  binding_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  binding TEXT NOT NULL
) STRICT;

-- Durable revocations. A revoked binding ID is blocked at every generation (generation
-- records the one current at revocation); a revoked device blocks every binding that
-- delivers through it.
CREATE TABLE revocations (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('binding', 'device')),
  target_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  PRIMARY KEY (target_kind, target_id, generation)
) STRICT;

CREATE TABLE commands (
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (owner_id, command_id)
) STRICT;

CREATE TABLE releases (
  release_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_ref TEXT NOT NULL UNIQUE REFERENCES payloads (payload_ref),
  job TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  FOREIGN KEY (owner_id, command_id) REFERENCES commands (owner_id, command_id)
) STRICT;

-- Each pending item (event + recipient generation) is released at most once.
CREATE TABLE release_items (
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  release_id TEXT NOT NULL REFERENCES releases (release_id),
  PRIMARY KEY (room_id, event_id, binding_id, generation)
) STRICT;

CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  correlation TEXT NOT NULL,
  receipt TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL
) STRICT;
CREATE INDEX receipts_release ON receipts (release_id);
`;

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Creates the schema in an empty ledger or verifies an existing one, inside the
 * caller's open transaction. A newer schema is never downgraded, and a file that is
 * SQLite but not this ledger is `corrupt`, never adopted.
 */
export function prepareSchema(db: DatabaseSync, mode: OpenMode): void {
  const applicationId = pragmaNumber(db, 'application_id');
  const version = pragmaNumber(db, 'user_version');
  const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as { n: number }).n;

  if (applicationId === 0 && version === 0 && tables === 0) {
    // An empty ledger where state should exist was lost or truncated, not new.
    if (mode === 'existing') throw new StorageError('corrupt');
    db.exec(SCHEMA_V1);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('ledger_revision', '0')").run();
    return;
  }
  if (applicationId !== APPLICATION_ID) throw new StorageError('corrupt');
  if (version > SCHEMA_VERSION) throw new StorageError('schema_unsupported');
  if (version < 1) throw new StorageError('corrupt');
  // Future migrations run here, one version step at a time, in this transaction.
}
