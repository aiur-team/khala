import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { StoreError } from './errors';

/** `PRAGMA application_id`: ASCII "KHCH" (Khala channel), distinct from connector storage. */
export const APPLICATION_ID = 0x4b484348;
export const SCHEMA_VERSION = 2;

export const CORE_SCHEMA_V1_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE participants (
  participant_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  display_name TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants (participant_id) ON DELETE RESTRICT,
  UNIQUE (device_id, participant_id)
) STRICT;

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  title TEXT,
  creator_participant_id TEXT NOT NULL,
  creator_device_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (creator_device_id, creator_participant_id)
    REFERENCES devices (device_id, participant_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE memberships (
  channel_id TEXT NOT NULL REFERENCES channels (channel_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL REFERENCES participants (participant_id) ON DELETE RESTRICT,
  membership TEXT NOT NULL CHECK (membership IN ('joining', 'joined', 'left', 'revoked')),
  PRIMARY KEY (channel_id, participant_id)
) STRICT;
CREATE INDEX memberships_participant_channel ON memberships (participant_id, channel_id);

CREATE TABLE bindings (
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  owner_id TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants (participant_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  PRIMARY KEY (binding_id, generation),
  FOREIGN KEY (device_id, participant_id)
    REFERENCES devices (device_id, participant_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX bindings_session ON bindings (harness, session_id, status);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels (channel_id) ON DELETE RESTRICT,
  author_participant_id TEXT NOT NULL,
  author_device_id TEXT NOT NULL,
  client_txn_id TEXT NOT NULL,
  canonical_payload BLOB NOT NULL,
  content_digest TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (author_device_id, author_participant_id)
    REFERENCES devices (device_id, participant_id) ON DELETE RESTRICT,
  UNIQUE (author_device_id, client_txn_id)
) STRICT;
CREATE INDEX events_channel_sequence ON events (channel_id, sequence);

CREATE TABLE channel_operations (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels (channel_id) ON DELETE RESTRICT
) STRICT;
`;

const MODE_CONTROLS_SQL = `
CREATE TABLE mode_controls (
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  requested TEXT NOT NULL CHECK (requested IN ('steer', 'sync', 'async')),
  version INTEGER NOT NULL CHECK (version >= 1),
  experimental_grants TEXT NOT NULL,
  hard_cancel_grants TEXT NOT NULL,
  PRIMARY KEY (binding_id, generation),
  FOREIGN KEY (binding_id, generation)
    REFERENCES bindings (binding_id, generation) ON DELETE RESTRICT
) STRICT;
`;

const MODE_OPERATIONS_SQL = `
CREATE TABLE mode_operations (
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK (result_kind IN ('applied', 'conflict')),
  result_control TEXT,
  PRIMARY KEY (binding_id, generation, operation_id),
  FOREIGN KEY (binding_id, generation)
    REFERENCES bindings (binding_id, generation) ON DELETE RESTRICT,
  CHECK ((result_kind = 'applied' AND result_control IS NOT NULL) OR result_kind = 'conflict')
) STRICT;
`;

export const MODE_SCHEMA_V2_SQL = `${MODE_CONTROLS_SQL}\n${MODE_OPERATIONS_SQL}`;

export type MigrationStage = 'after_mode_controls' | 'after_mode_operations' | 'before_user_version' | 'after_user_version';
export type MigrationFault = (stage: MigrationStage) => void;

function pragmaNumber(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] : Number.NaN);
}

/** Existing files are identified from pinned raw bytes before SQLite can make sidecars. */
export function validateRawHeader(header: Buffer): Readonly<{ version: number }> {
  if (header.length < 100 || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary'))) {
    throw new StoreError('corrupt');
  }
  const applicationId = header.readUInt32BE(68);
  const version = header.readUInt32BE(60);
  if (applicationId !== APPLICATION_ID) throw new StoreError('corrupt');
  if (version > SCHEMA_VERSION) throw new StoreError('schema_unsupported');
  if (version < 1) throw new StoreError('corrupt');
  return { version };
}

type SchemaRow = Readonly<{ type: string; name: string; tbl_name: string; sql: string | null }>;

function schemaRows(db: DatabaseSync): readonly SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as unknown as SchemaRow[];
}

function normalizeSql(sql: string | null): string | null {
  return sql?.replace(/\s+/g, ' ').trim().replace(/;$/, '') ?? null;
}

const expectedManifests = new Map<number, readonly SchemaRow[]>();

function expectedManifest(version: number): readonly SchemaRow[] {
  const cached = expectedManifests.get(version);
  if (cached) return cached;
  const expected = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    expected.exec(CORE_SCHEMA_V1_SQL);
    if (version >= 2) expected.exec(MODE_SCHEMA_V2_SQL);
    const rows = schemaRows(expected).map(row => ({ ...row, sql: normalizeSql(row.sql) }));
    expectedManifests.set(version, rows);
    return rows;
  } finally {
    expected.close();
  }
}

function assertManifest(db: DatabaseSync, version: number): void {
  const actual = schemaRows(db).map(row => ({ ...row, sql: normalizeSql(row.sql) }));
  if (JSON.stringify(actual) !== JSON.stringify(expectedManifest(version))) throw new StoreError('corrupt');
}

function rows(statement: StatementSync): readonly unknown[] {
  return statement.all();
}

function assertIntegrity(db: DatabaseSync): void {
  if (rows(db.prepare('PRAGMA foreign_key_check')).length !== 0) throw new StoreError('corrupt');
  const checks = rows(db.prepare('PRAGMA quick_check')) as Array<Record<string, unknown>>;
  if (checks.length !== 1 || Object.values(checks[0] ?? {})[0] !== 'ok') throw new StoreError('corrupt');
}

/** Creates or migrates inside the caller's exclusive transaction. */
export function prepareSchema(
  db: DatabaseSync,
  mode: 'create' | 'existing',
  created: boolean,
  migrationFault?: MigrationFault,
): void {
  const applicationId = pragmaNumber(db, 'application_id');
  const version = pragmaNumber(db, 'user_version');
  const objects = schemaRows(db);

  if (created) {
    if (mode !== 'create' || applicationId !== 0 || version !== 0 || objects.length !== 0) throw new StoreError('corrupt');
    db.exec(CORE_SCHEMA_V1_SQL);
    db.exec(MODE_CONTROLS_SQL);
    db.exec(MODE_OPERATIONS_SQL);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    assertManifest(db, SCHEMA_VERSION);
    assertIntegrity(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  if (applicationId !== APPLICATION_ID) throw new StoreError('corrupt');
  if (version > SCHEMA_VERSION) throw new StoreError('schema_unsupported');
  if (version < 1) throw new StoreError('corrupt');
  assertManifest(db, version);
  assertIntegrity(db);

  if (version === 1) {
    db.exec(MODE_CONTROLS_SQL);
    migrationFault?.('after_mode_controls');
    db.exec(MODE_OPERATIONS_SQL);
    migrationFault?.('after_mode_operations');
    assertManifest(db, 2);
    assertIntegrity(db);
    migrationFault?.('before_user_version');
    db.exec('PRAGMA user_version = 2');
    migrationFault?.('after_user_version');
  }
}
