import type { CallOptions, ControlStore, OwnerId, WriteResult } from '@khala/contracts/messaging/index';
import { decodeOperation, encodeOperation, type OperationRecord } from './operation';

export type StoredOperation = Readonly<{ key: string; record: OperationRecord; revision: string }>;
export type LoadedOperation =
  | Readonly<{ kind: 'absent'; key: string }>
  | Readonly<{ kind: 'found'; stored: StoredOperation }>
  | Readonly<{ kind: 'unavailable' }>;
export type SavedOperation = Readonly<{ kind: 'saved'; stored: StoredOperation }> | Readonly<{ kind: 'unsaved' }>;
type Written = WriteResult | Readonly<{ kind: 'outcome_unknown'; operationId: string }>;

export async function recoveryJournalKey(ownerId: OwnerId, operationId: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([ownerId, operationId]));
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return `recovery/${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

export function recoveryJournal(ownerId: OwnerId, store: ControlStore) {
  async function load(operationId: string, options?: CallOptions): Promise<LoadedOperation> {
    const key = await recoveryJournalKey(ownerId, operationId);
    if (key === null) return { kind: 'unavailable' };
    const read = await store.read(key, options);
    if (read.kind === 'unavailable') return read;
    if (read.kind === 'absent') return { kind: 'absent', key };
    const record = decodeOperation(read.record.value);
    if (record === null || record.ownerId !== ownerId || record.operationId !== operationId) return { kind: 'unavailable' };
    return { kind: 'found', stored: { key, record, revision: read.record.revision } };
  }

  async function write(
    key: string,
    expectedRevision: string | null,
    record: OperationRecord,
    options?: CallOptions,
  ): Promise<Written> {
    const writeId = `${key}#${record.seq}.${record.state}.${record.attempts}`;
    const result = await store.compareAndSet({
      key, expectedRevision, operationId: writeId, next: { value: encodeOperation(record), expiresAt: null },
    }, options);
    if (result.kind !== 'outcome_unknown') return result;
    const resolved = await store.resolve({ key, operationId: writeId }, options);
    if (resolved.kind === 'applied') return resolved;
    return resolved.kind === 'not_applied' ? { kind: 'unavailable' } : { kind: 'outcome_unknown', operationId: writeId };
  }

  async function create(key: string, record: OperationRecord, options?: CallOptions): Promise<Written> {
    return write(key, null, record, options);
  }

  async function save(current: StoredOperation, next: OperationRecord, options?: CallOptions): Promise<SavedOperation> {
    const record = { ...next, seq: current.record.seq + 1 };
    const result = await write(current.key, current.revision, record, options);
    return result.kind === 'applied'
      ? { kind: 'saved', stored: { key: current.key, record, revision: result.record.revision } }
      : { kind: 'unsaved' };
  }

  return { load, create, save };
}
