// Operation journal over the contract `ControlStore`, shared by the owner-facing service and
// the endpoint-facing acknowledgment receiver. Each write is guarded by the revision it read.

import type { CallOptions, ControlStore, OwnerId, WriteResult } from '@khala/contracts/messaging/index';
import { type OperationRecord, boundaryCode, decodeOperation, encodeOperation } from './operation';

/**
 * Journal key for one owner's operation. Operation IDs are scoped per owner, so one owner cannot
 * probe or occupy another's. The pair is hashed so the key stays within the contract's identifier
 * limit however long the IDs are. `null` means Web Crypto is unavailable.
 */
export async function journalKey(ownerId: OwnerId, operationId: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([ownerId, operationId]));
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return `revocation/${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

export type Stored = Readonly<{ key: string; record: OperationRecord; revision: string }>;
export type Loaded = Readonly<{ kind: 'absent'; key: string }> | Readonly<{ kind: 'found'; stored: Stored }> | Readonly<{ kind: 'unavailable' }>;
export type Saved = Readonly<{ kind: 'saved'; stored: Stored }> | Readonly<{ kind: 'unsaved' }>;
type Written = WriteResult | Readonly<{ kind: 'outcome_unknown'; operationId: string }>;

export type OperationJournal = Readonly<{
  load(operationId: string, options?: CallOptions): Promise<Loaded>;
  /** Writes a new record. Anything short of `applied` means it may not exist. */
  create(key: string, record: OperationRecord, options?: CallOptions): Promise<Written>;
  save(current: Stored, next: OperationRecord, options?: CallOptions): Promise<Saved>;
}>;

export function operationJournal(ownerId: OwnerId, store: ControlStore): OperationJournal {
  async function load(operationId: string, options?: CallOptions): Promise<Loaded> {
    const key = await journalKey(ownerId, operationId);
    if (key === null) return { kind: 'unavailable' };
    const read = await store.read(key, options);
    if (read.kind === 'unavailable') return read;
    if (read.kind === 'absent') return { kind: 'absent', key };
    const record = decodeOperation(read.record.value);
    // A record that this module cannot read is never guessed at, and it is never overwritten.
    if (record === null || record.operationId !== operationId || record.ownerId !== ownerId) return { kind: 'unavailable' };
    return { kind: 'found', stored: { key, record, revision: read.record.revision } };
  }

  /**
   * The store operation ID names both the position and the content of a write. A retry of the same
   * transition reuses it and can be resolved, and a different transition never reuses it.
   */
  async function write(key: string, expectedRevision: string | null, record: OperationRecord, options?: CallOptions): Promise<Written> {
    const writeId = `${key}#${record.seq}.${boundaryCode(record)}`;
    const result = await store.compareAndSet(
      { key, expectedRevision, operationId: writeId, next: { value: encodeOperation(record), expiresAt: null } },
      options,
    );
    if (result.kind !== 'outcome_unknown') return result;
    const resolved = await store.resolve({ key, operationId: writeId }, options);
    if (resolved.kind === 'applied') return resolved;
    // Only a proof that the write did not land makes it `unavailable`. Anything else stays unknown.
    return resolved.kind === 'not_applied' ? { kind: 'unavailable' } : { kind: 'outcome_unknown', operationId: writeId };
  }

  async function save(current: Stored, next: OperationRecord, options?: CallOptions): Promise<Saved> {
    const record = { ...next, seq: current.record.seq + 1 };
    const result = await write(current.key, current.revision, record, options);
    return result.kind === 'applied'
      ? { kind: 'saved', stored: { key: current.key, record, revision: result.record.revision } }
      : { kind: 'unsaved' };
  }

  return { load, create: (key, record, options) => write(key, null, record, options), save };
}
