import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { StoreError } from './errors';

/** `PRAGMA application_id`: ASCII "KHCH" (Khala channel), distinct from connector storage. */
export const APPLICATION_ID = 0x4b484348;
export const SCHEMA_VERSION = 5;

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

/** v3 records who made the last change; NULL is a pre-actor row and reads as `unknown`. */
export const MODE_SCHEMA_V3_SQL = 'ALTER TABLE mode_controls ADD COLUMN last_changed_by TEXT;';

/**
 * Owner-local projection of connector receipt facts. The connector ledger stays
 * authoritative; these rows are immutable copies keyed by the stable receipt ID and
 * joined to channel events by reference only. Nothing here holds message content or a
 * batch token.
 */
export const RECEIPT_SCHEMA_V4_SQL = `
CREATE TABLE receipt_facts (
  receipt_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  evidence_ref TEXT,
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 1),
  receipt TEXT NOT NULL
) STRICT;
CREATE INDEX receipt_facts_evidence ON receipt_facts (evidence_ref);

CREATE TABLE receipt_fact_events (
  receipt_id TEXT NOT NULL REFERENCES receipt_facts (receipt_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  channel_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (receipt_id, position)
) STRICT;
CREATE INDEX receipt_fact_events_event ON receipt_fact_events (channel_id, event_id);

CREATE TABLE receipt_projection_checkpoints (
  source TEXT PRIMARY KEY,
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 0)
) STRICT;
`;

/**
 * Channel discovery. `control_records`/`control_operations` back the shared
 * `ControlStore` used by the channel-access journal, grant exchange and grant
 * issuer. The discovery tables hold owner visibility, the explicit per-principal
 * allowlist, issued discovery agents (capability digests only), admission
 * operations and the binding each exchanged operation activated. A channel without a visibility row is `private` with no allowlist.
 */
export const DISCOVERY_SCHEMA_V5_SQL = `
CREATE TABLE control_records (
  record_key TEXT PRIMARY KEY,
  revision TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE control_operations (
  operation_id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE discovery_agents (
  principal TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  session_digest TEXT NOT NULL,
  display_label TEXT,
  workspace_label TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  capability_digest TEXT NOT NULL UNIQUE,
  proof_public_key TEXT NOT NULL,
  proof_thumbprint TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  UNIQUE (harness, session_digest)
) STRICT;

CREATE TABLE discovery_visibility (
  channel_id TEXT PRIMARY KEY REFERENCES channels (channel_id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'secret')),
  visibility_epoch INTEGER NOT NULL CHECK (visibility_epoch >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;

CREATE TABLE discovery_allowlist (
  channel_id TEXT NOT NULL REFERENCES channels (channel_id) ON DELETE RESTRICT,
  principal TEXT NOT NULL REFERENCES discovery_agents (principal) ON DELETE RESTRICT,
  PRIMARY KEY (channel_id, principal)
) STRICT;

CREATE TABLE discovery_operations (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL
) STRICT;

CREATE TABLE admission_operations (
  provider_operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  membership TEXT NOT NULL CHECK (membership IN ('joined', 'already_joined'))
) STRICT;

CREATE TABLE discovery_activations (
  operation_key TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  channel_id TEXT NOT NULL REFERENCES channels (channel_id) ON DELETE RESTRICT,
  session_generation INTEGER NOT NULL CHECK (session_generation >= 1),
  UNIQUE (binding_id, generation),
  FOREIGN KEY (binding_id, generation) REFERENCES bindings (binding_id, generation) ON DELETE RESTRICT
) STRICT;
`;

export type MigrationStage =
  | 'after_mode_controls' | 'after_mode_operations' | 'before_user_version' | 'after_user_version'
  | 'after_receipt_tables' | 'before_receipt_user_version'
  | 'after_discovery_tables' | 'before_discovery_user_version';
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
    if (version >= 3) expected.exec(MODE_SCHEMA_V3_SQL);
    if (version >= 4) expected.exec(RECEIPT_SCHEMA_V4_SQL);
    if (version >= 5) expected.exec(DISCOVERY_SCHEMA_V5_SQL);
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
    db.exec(MODE_SCHEMA_V3_SQL);
    db.exec(RECEIPT_SCHEMA_V4_SQL);
    db.exec(DISCOVERY_SCHEMA_V5_SQL);
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
    db.exec(MODE_SCHEMA_V3_SQL);
    assertManifest(db, 3);
    assertIntegrity(db);
    migrationFault?.('before_user_version');
    db.exec('PRAGMA user_version = 3');
    migrationFault?.('after_user_version');
  }

  if (version === 2) {
    db.exec(MODE_SCHEMA_V3_SQL);
    assertManifest(db, 3);
    assertIntegrity(db);
    migrationFault?.('before_user_version');
    db.exec('PRAGMA user_version = 3');
    migrationFault?.('after_user_version');
  }

  if (version <= 3) {
    db.exec(RECEIPT_SCHEMA_V4_SQL);
    migrationFault?.('after_receipt_tables');
    assertManifest(db, 4);
    assertIntegrity(db);
    migrationFault?.('before_receipt_user_version');
    db.exec('PRAGMA user_version = 4');
  }

  if (version <= 4) {
    db.exec(DISCOVERY_SCHEMA_V5_SQL);
    migrationFault?.('after_discovery_tables');
    assertManifest(db, 5);
    assertIntegrity(db);
    migrationFault?.('before_discovery_user_version');
    db.exec('PRAGMA user_version = 5');
  }
}
