// Durable bootstrap state that shares the owner connector's already-open ledger.
// Bootstrap operation rows and signer material intentionally do not advance the
// application ledger revision: if the process dies before binding the recovered SDK
// identity, reopening must not mistake these preparatory rows for adoptable state.

import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { decodeSessionBinding, sameSessionBinding } from '@khala/contracts/delivery/index';
import type {
  BootstrapOperationStore, OperationRead, OperationRecord, OperationWrite,
} from '../bootstrap/ports';
import { type ProofSigner, createProofSigner } from '../bootstrap/proof';
import { StorageError } from './errors';
import { requireCount, requireIdentifier, runTransaction } from './ledger';
import { type ConnectorStorage, storageInternals } from './open';

const PHASES: readonly OperationRecord['phase'][] = ['reserved', 'admitted', 'repair_required', 'connected'];
const OPERATION_KEYS = ['binding', 'deviceId', 'fingerprint', 'operationId', 'phase', 'v'];

function context(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals || !internals.isOpen()) throw new StorageError('closed');
  return internals.ctx;
}

function decodeOperation(input: unknown, stored: boolean): OperationRecord {
  const fail = (): never => { throw new StorageError(stored ? 'corrupt' : 'invalid_input'); };
  if (typeof input !== 'object' || input === null) return fail();
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== OPERATION_KEYS.length || keys.some((key, index) => key !== OPERATION_KEYS[index])) return fail();
  if (value.v !== 1 || !PHASES.includes(value.phase as OperationRecord['phase'])) return fail();
  let operationId: string;
  let fingerprint: string;
  let deviceId: string;
  try {
    operationId = requireIdentifier(value.operationId);
    fingerprint = requireIdentifier(value.fingerprint);
    deviceId = requireIdentifier(value.deviceId);
  } catch {
    return fail();
  }
  let binding: SessionBinding | null = null;
  if (value.binding !== null) {
    const decoded = decodeSessionBinding(value.binding);
    if (!decoded.ok) return fail();
    binding = decoded.value;
  }
  const phase = value.phase as OperationRecord['phase'];
  if ((phase === 'reserved') !== (binding === null)) return fail();
  if (binding !== null && binding.deviceId !== deviceId) return fail();
  return { v: 1, operationId, fingerprint, phase, deviceId, binding };
}

function parseOperation(json: string): OperationRecord {
  try {
    return decodeOperation(JSON.parse(json), true);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('corrupt');
  }
}

function sameBinding(a: SessionBinding | null, b: SessionBinding | null): boolean {
  return a === null ? b === null : b !== null && sameSessionBinding(a, b);
}

/** A real SQLite-backed `BootstrapOperationStore` over the already-owned ledger. */
export function createBootstrapOperationStore(storage: ConnectorStorage): BootstrapOperationStore {
  return {
    async load(operationId): Promise<OperationRead> {
      const id = requireIdentifier(operationId);
      const ctx = context(storage);
      return runTransaction(ctx, () => {
        const row = ctx.db.prepare(`SELECT fingerprint, revision, record FROM bootstrap_operations
          WHERE operation_id = ?`).get(id) as { fingerprint: string; revision: number; record: string } | undefined;
        if (!row) return { kind: 'absent' };
        const record = parseOperation(row.record);
        if (record.operationId !== id || record.fingerprint !== row.fingerprint || row.revision < 1) {
          throw new StorageError('corrupt');
        }
        return { kind: 'record', record, revision: row.revision };
      });
    },

    async save(input, expectedRevision): Promise<OperationWrite> {
      const record = decodeOperation(input, false);
      if (expectedRevision !== null) requireCount(expectedRevision);
      const ctx = context(storage);
      return runTransaction(ctx, () => {
        const row = ctx.db.prepare(`SELECT fingerprint, revision, record FROM bootstrap_operations
          WHERE operation_id = ?`).get(record.operationId) as
          | { fingerprint: string; revision: number; record: string }
          | undefined;
        if (row === undefined) {
          if (expectedRevision !== null) return { kind: 'conflict' };
          ctx.db.prepare(`INSERT INTO bootstrap_operations (operation_id, fingerprint, revision, record)
            VALUES (?, ?, 1, ?)`).run(record.operationId, record.fingerprint, JSON.stringify(record));
          return { kind: 'saved', revision: 1 };
        }
        const current = parseOperation(row.record);
        if (row.revision !== expectedRevision || row.fingerprint !== record.fingerprint
          || current.fingerprint !== record.fingerprint || current.deviceId !== record.deviceId
          || (current.binding !== null && !sameBinding(current.binding, record.binding))) {
          return { kind: 'conflict' };
        }
        const revision = row.revision + 1;
        ctx.db.prepare('UPDATE bootstrap_operations SET revision = ?, record = ? WHERE operation_id = ?')
          .run(revision, JSON.stringify(record), record.operationId);
        return { kind: 'saved', revision };
      });
    },
  };
}

function signerFrom(bytes: Uint8Array, clock: () => number): ProofSigner {
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(bytes), format: 'der', type: 'pkcs8' });
    return createProofSigner(privateKey, clock);
  } catch {
    throw new StorageError('corrupt');
  }
}

/**
 * Loads the ledger's one Ed25519 proof key, creating it only when absent. The PKCS8
 * bytes never leave this module; callers receive the constrained proof signer.
 */
export async function loadOrCreateBootstrapSigner(
  storage: ConnectorStorage,
  clock: () => number = Date.now,
): Promise<ProofSigner> {
  const ctx = context(storage);
  const stored = runTransaction(ctx, () => ctx.db.prepare(
    'SELECT private_key FROM bootstrap_signer WHERE singleton = 1',
  ).get() as { private_key: Uint8Array } | undefined);
  if (stored !== undefined) return signerFrom(new Uint8Array(stored.private_key), clock);

  const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  const bytes = new Uint8Array(generated);
  runTransaction(ctx, () => {
    ctx.db.prepare('INSERT INTO bootstrap_signer (singleton, private_key) VALUES (1, ?)').run(bytes);
  });
  return signerFrom(bytes, clock);
}

/** Composition convenience: both durable bootstrap ports over one storage lease. */
export async function createBootstrapPersistence(
  storage: ConnectorStorage,
  clock: () => number = Date.now,
): Promise<Readonly<{ operations: BootstrapOperationStore; signer: ProofSigner }>> {
  return {
    operations: createBootstrapOperationStore(storage),
    signer: await loadOrCreateBootstrapSigner(storage, clock),
  };
}
