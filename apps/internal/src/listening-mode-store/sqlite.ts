import type { DatabaseSync } from 'node:sqlite';
import {
  LISTENING_MODES,
  type ListeningModeControl,
  type RouteGrant,
  readListeningModeActor,
} from '@khala/contracts/delivery/index';
import {
  array, decodeWith, fail, identifier, literal, nullable, object, safeInteger, version,
} from '@khala/contracts/delivery/decode';
import { readId } from '@khala/contracts/delivery/ids';
import type { InternalStoreHandle } from '../store/open';

export type SqliteListeningModeStoreKey = Pick<ListeningModeControl, 'bindingId' | 'generation'>;
export type SqliteListeningModeStoreNext = Pick<
  ListeningModeControl,
  'requested' | 'experimentalGrants' | 'hardCancelGrants' | 'lastChangedBy'
>;
export type SqliteListeningModeStoreWrite = Readonly<{
  key: SqliteListeningModeStoreKey;
  expectedVersion: number | null;
  operationId: string;
  operationFingerprint: string;
  next: SqliteListeningModeStoreNext;
}>;
export type SqliteListeningModeStoreRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; control: ListeningModeControl }>
  | Readonly<{ kind: 'unavailable' }>;
export type SqliteListeningModeWriteResult =
  | Readonly<{ kind: 'applied'; control: ListeningModeControl }>
  | Readonly<{ kind: 'conflict'; current: ListeningModeControl | null }>
  | Readonly<{ kind: 'idempotency_conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface SqliteListeningModeRepository {
  read(key: SqliteListeningModeStoreKey): SqliteListeningModeStoreRead;
  compareAndSet(write: SqliteListeningModeStoreWrite): SqliteListeningModeWriteResult;
  /** Trusted synchronous seed used by conformance fixtures; production initializes through CAS. */
  initialize(control: ListeningModeControl): boolean;
}

export type SqliteListeningModeRepositoryOptions = Readonly<{
  /** Test-only interruption after the logical control change and before its operation journal row. */
  beforeOperationJournal?: () => void;
}>;

type ControlRow = Readonly<{
  binding_id: unknown;
  generation: unknown;
  requested: unknown;
  version: unknown;
  experimental_grants: unknown;
  hard_cancel_grants: unknown;
  last_changed_by: unknown;
}>;

type OperationRow = Readonly<{
  fingerprint: unknown;
  result_kind: unknown;
  result_control: unknown;
}>;

const CONTROL_FIELDS = [
  'bindingId', 'generation', 'requested', 'version', 'experimentalGrants', 'hardCancelGrants',
] as const;
const GRANT_FIELDS = [
  'v', 'kind', 'bindingId', 'generation', 'mode', 'route', 'harnessVersion',
  'evidenceRevision', 'grantRevision',
] as const;

function positiveInteger(input: unknown, field: string): number {
  const value = safeInteger(input, field);
  if (value < 1) fail(field, 'invalid_field');
  return value;
}

function readGrant(
  input: unknown,
  field: string,
  expectedKind: RouteGrant['kind'],
  key: SqliteListeningModeStoreKey,
  controlVersion: number,
): RouteGrant {
  const reader = object(input, field, GRANT_FIELDS);
  const grant: RouteGrant = {
    v: version(reader.field('v'), reader.at('v')),
    kind: literal(reader.field('kind'), reader.at('kind'), [expectedKind]),
    bindingId: readId<'BindingId'>(reader.field('bindingId'), reader.at('bindingId')),
    generation: safeInteger(reader.field('generation'), reader.at('generation')),
    mode: literal(reader.field('mode'), reader.at('mode'), LISTENING_MODES),
    route: identifier(reader.field('route'), reader.at('route')),
    harnessVersion: identifier(reader.field('harnessVersion'), reader.at('harnessVersion')),
    evidenceRevision: identifier(reader.field('evidenceRevision'), reader.at('evidenceRevision')),
    grantRevision: positiveInteger(reader.field('grantRevision'), reader.at('grantRevision')),
  };
  if (grant.bindingId !== key.bindingId || grant.generation !== key.generation
    || grant.grantRevision > controlVersion) fail(field, 'invalid_field');
  return grant;
}

function decodeControl(input: unknown): ListeningModeControl | null {
  const decoded = decodeWith(() => {
    // `lastChangedBy` is absent from records written before actors were recorded.
    const hasActor = typeof input === 'object' && input !== null && Object.hasOwn(input, 'lastChangedBy');
    const reader = object(input, '', hasActor ? [...CONTROL_FIELDS, 'lastChangedBy'] : CONTROL_FIELDS);
    const key: SqliteListeningModeStoreKey = {
      bindingId: readId<'BindingId'>(reader.field('bindingId'), reader.at('bindingId')),
      generation: safeInteger(reader.field('generation'), reader.at('generation')),
    };
    const controlVersion = positiveInteger(reader.field('version'), reader.at('version'));
    return {
      ...key,
      requested: nullable(reader.field('requested'), value => literal(value, reader.at('requested'), LISTENING_MODES)),
      version: controlVersion,
      experimentalGrants: array(reader.field('experimentalGrants'), reader.at('experimentalGrants'))
        .map((grant, index) => readGrant(
          grant, `${reader.at('experimentalGrants')}[${index}]`, 'experimental_route', key, controlVersion,
        )),
      hardCancelGrants: array(reader.field('hardCancelGrants'), reader.at('hardCancelGrants'))
        .map((grant, index) => readGrant(
          grant, `${reader.at('hardCancelGrants')}[${index}]`, 'hard_cancel', key, controlVersion,
        )),
      lastChangedBy: readListeningModeActor(
        hasActor ? reader.field('lastChangedBy') : undefined, reader.at('lastChangedBy'),
      ),
    } satisfies ListeningModeControl;
  });
  return decoded.ok ? decoded.value : null;
}

function parseJson(value: unknown): unknown | null {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function controlFromRow(row: ControlRow): ListeningModeControl | null {
  const experimentalGrants = parseJson(row.experimental_grants);
  const hardCancelGrants = parseJson(row.hard_cancel_grants);
  if (experimentalGrants === null || hardCancelGrants === null) return null;
  const lastChangedBy = row.last_changed_by === null ? undefined : parseJson(row.last_changed_by);
  if (lastChangedBy === null) return null;
  return decodeControl({
    bindingId: row.binding_id,
    generation: row.generation,
    requested: row.requested,
    version: row.version,
    experimentalGrants,
    hardCancelGrants,
    lastChangedBy,
  });
}

function queryControl(db: DatabaseSync, key: SqliteListeningModeStoreKey): ListeningModeControl | null | 'corrupt' {
  const row = db.prepare(`
    SELECT binding_id, generation, requested, version, experimental_grants, hard_cancel_grants, last_changed_by
    FROM mode_controls WHERE binding_id = ? AND generation = ?
  `).get(key.bindingId, key.generation) as ControlRow | undefined;
  if (!row) return null;
  const control = controlFromRow(row);
  return control ?? 'corrupt';
}

function validKey(key: SqliteListeningModeStoreKey): boolean {
  return decodeWith(() => ({
    bindingId: readId<'BindingId'>(key.bindingId, 'bindingId'),
    generation: safeInteger(key.generation, 'generation'),
  })).ok;
}

function validWriteShape(write: SqliteListeningModeStoreWrite): boolean {
  return validKey(write.key)
    && decodeWith(() => identifier(write.operationId, 'operationId')).ok
    && typeof write.operationFingerprint === 'string'
    && (write.expectedVersion === null || decodeWith(() => safeInteger(write.expectedVersion, 'expectedVersion')).ok);
}

function sameKey(control: ListeningModeControl, key: SqliteListeningModeStoreKey): boolean {
  return control.bindingId === key.bindingId && control.generation === key.generation;
}

function operationResult(row: OperationRow, key: SqliteListeningModeStoreKey): Exclude<
  SqliteListeningModeWriteResult,
  { kind: 'idempotency_conflict' | 'unavailable' }
> | null {
  if (row.result_kind !== 'applied' && row.result_kind !== 'conflict') return null;
  if (row.result_control === null) return row.result_kind === 'conflict'
    ? { kind: 'conflict', current: null }
    : null;
  const parsed = parseJson(row.result_control);
  const control = parsed === null ? null : decodeControl(parsed);
  if (!control || !sameKey(control, key)) return null;
  return row.result_kind === 'applied'
    ? { kind: 'applied', control }
    : { kind: 'conflict', current: control };
}

function writeControl(db: DatabaseSync, control: ListeningModeControl, existing: ListeningModeControl | null): void {
  const bindings = [
    control.requested,
    control.version,
    JSON.stringify(control.experimentalGrants),
    JSON.stringify(control.hardCancelGrants),
    JSON.stringify(control.lastChangedBy),
    control.bindingId,
    control.generation,
  ] as const;
  if (existing === null) {
    db.prepare(`
      INSERT INTO mode_controls (
        requested, version, experimental_grants, hard_cancel_grants, last_changed_by, binding_id, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(...bindings);
    return;
  }
  const updated = db.prepare(`
    UPDATE mode_controls
    SET requested = ?, version = ?, experimental_grants = ?, hard_cancel_grants = ?, last_changed_by = ?
    WHERE binding_id = ? AND generation = ? AND version = ?
  `).run(...bindings, existing.version);
  if (updated.changes !== 1) throw new Error('listening-mode version changed during transaction');
}

function insertOperation(
  db: DatabaseSync,
  write: SqliteListeningModeStoreWrite,
  result: Extract<SqliteListeningModeWriteResult, { kind: 'applied' | 'conflict' }>,
): void {
  const control = result.kind === 'applied' ? result.control : result.current;
  db.prepare(`
    INSERT INTO mode_operations (
      binding_id, generation, operation_id, fingerprint, result_kind, result_control
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    write.key.bindingId,
    write.key.generation,
    write.operationId,
    write.operationFingerprint,
    result.kind,
    control === null ? null : JSON.stringify(control),
  );
}

/** Raw synchronous persistence; policy types and behavior remain in the composition wrapper. */
export function createSqliteListeningModeRepository(
  handle: InternalStoreHandle,
  options: SqliteListeningModeRepositoryOptions = {},
): SqliteListeningModeRepository {
  return {
    read(key) {
      if (!validKey(key)) return { kind: 'unavailable' };
      try {
        const control = handle.read(db => queryControl(db, key));
        if (control === 'corrupt') return { kind: 'unavailable' };
        return control === null ? { kind: 'absent' } : { kind: 'record', control };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    compareAndSet(write) {
      if (!validWriteShape(write)) return { kind: 'unavailable' };
      try {
        return handle.transaction(db => {
          const prior = db.prepare(`
            SELECT fingerprint, result_kind, result_control
            FROM mode_operations
            WHERE binding_id = ? AND generation = ? AND operation_id = ?
          `).get(write.key.bindingId, write.key.generation, write.operationId) as OperationRow | undefined;
          if (prior) {
            const result = operationResult(prior, write.key);
            if (!result || typeof prior.fingerprint !== 'string') return { kind: 'unavailable' } as const;
            return prior.fingerprint === write.operationFingerprint
              ? result
              : { kind: 'idempotency_conflict' } as const;
          }

          const persisted = queryControl(db, write.key);
          if (persisted === 'corrupt') return { kind: 'unavailable' } as const;
          const current = persisted;
          let result: Extract<SqliteListeningModeWriteResult, { kind: 'applied' | 'conflict' }>;
          if ((current?.version ?? null) !== write.expectedVersion) {
            result = { kind: 'conflict', current };
          } else {
            const candidate = decodeControl({
              ...write.key,
              ...write.next,
              version: (current?.version ?? 0) + 1,
            });
            if (!candidate) return { kind: 'unavailable' } as const;
            writeControl(db, candidate, current);
            result = { kind: 'applied', control: candidate };
          }
          options.beforeOperationJournal?.();
          insertOperation(db, write, result);
          return result;
        });
      } catch {
        return { kind: 'unavailable' };
      }
    },

    initialize(control) {
      const decoded = decodeControl(control);
      if (!decoded) return false;
      try {
        return handle.transaction(db => {
          const existing = queryControl(db, decoded);
          if (existing === 'corrupt') return false;
          if (existing !== null) return JSON.stringify(existing) === JSON.stringify(decoded);
          writeControl(db, decoded, null);
          return true;
        });
      } catch {
        return false;
      }
    },
  };
}
