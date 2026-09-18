import { describe, expect, it } from 'vitest';
import { createControlStore, type BlobsStoreLike } from './control-store';

type Entry = Readonly<{ data: unknown; etag: string }>;

/**
 * In-memory stand-in for a single `@netlify/blobs` `Store`. Mirrors the real
 * SDK's CAS semantics: `onlyIfNew` only succeeds against a key that has never
 * been written, `onlyIfMatch` only succeeds against the exact current etag,
 * and a physically-present-but-logically-expired key is not the same as an
 * absent one (the adapter, not this fake, is responsible for that distinction).
 */
class FakeBlobsStore implements BlobsStoreLike {
  private entries = new Map<string, Entry>();
  private revision = 0;
  private nextRejection: 'definite' | 'ambiguous' | null = null;
  private lostResponseOnNextSet = false;

  failNext(mode: 'definite' | 'ambiguous'): void {
    this.nextRejection = mode;
  }

  /** Simulates a write that lands server-side but whose response never reaches this caller. */
  loseResponseOnNextSet(): void {
    this.lostResponseOnNextSet = true;
  }

  private throwRejection(mode: 'definite' | 'ambiguous'): never {
    if (mode === 'definite') {
      const error = new Error('service rejected the request') as Error & { status: number };
      error.status = 503;
      throw error;
    }
    throw new Error('network timeout');
  }

  private consumePreflightFailure(): void {
    if (this.nextRejection === null) return;
    const mode = this.nextRejection;
    this.nextRejection = null;
    this.throwRejection(mode);
  }

  async getWithMetadata(key: string): Promise<{ data: unknown; etag?: string } | null> {
    this.consumePreflightFailure();
    const entry = this.entries.get(key);
    return entry ? { data: entry.data, etag: entry.etag } : null;
  }

  async setJSON(key: string, data: unknown, options: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}): Promise<{ modified: boolean; etag?: string }> {
    this.consumePreflightFailure();
    const current = this.entries.get(key);
    const preconditionOk = options.onlyIfNew ? !current : options.onlyIfMatch !== undefined ? current?.etag === options.onlyIfMatch : true;
    if (!preconditionOk) return { modified: false };
    this.revision += 1;
    const etag = `r${this.revision}`;
    this.entries.set(key, { data, etag });
    if (this.lostResponseOnNextSet) {
      this.lostResponseOnNextSet = false;
      throw new Error('network timeout');
    }
    return { modified: true, etag };
  }
}

function makeStore(nowMs = Date.parse('2026-09-16T00:00:00Z')) {
  const records = new FakeBlobsStore();
  const operations = new FakeBlobsStore();
  let now = nowMs;
  const store = createControlStore({ records, operations, clock: () => now });
  return { store, records, operations, setClock: (value: number) => { now = value; } };
}

describe('createControlStore', () => {
  it('two create-if-absent requests have one winner', async () => {
    const { store } = makeStore();
    const a = await store.compareAndSet({ key: 'room/owner', expectedRevision: null, operationId: 'op_a', next: { value: 'alice', expiresAt: null } });
    expect(a).toMatchObject({ kind: 'applied', record: { value: 'alice' } });
    const b = await store.compareAndSet({ key: 'room/owner', expectedRevision: null, operationId: 'op_b', next: { value: 'bob', expiresAt: null } });
    expect(b).toMatchObject({ kind: 'conflict', current: { value: 'alice' } });
    expect(await store.read('room/owner')).toMatchObject({ kind: 'record', record: { value: 'alice' } });
  });

  it('two writers on one revision cannot both apply', async () => {
    const { store } = makeStore();
    const created = await store.compareAndSet({ key: 'policy/a1', expectedRevision: null, operationId: 'op_c', next: { value: { gate: 'review' }, expiresAt: null } });
    expect(created.kind).toBe('applied');
    const r1 = created.kind === 'applied' ? created.record.revision : never();
    const w1 = await store.compareAndSet({ key: 'policy/a1', expectedRevision: r1, operationId: 'op_w1', next: { value: { gate: 'open' }, expiresAt: null } });
    expect(w1).toMatchObject({ kind: 'applied', record: { value: { gate: 'open' } } });
    const w2 = await store.compareAndSet({ key: 'policy/a1', expectedRevision: r1, operationId: 'op_w2', next: { value: { gate: 'closed' }, expiresAt: null } });
    expect(w2).toMatchObject({ kind: 'conflict', current: { value: { gate: 'open' } } });
  });

  it('missing ETag refuses before an unconditional write: updating an absent key is a conflict, not a create', async () => {
    const { store } = makeStore();
    const result = await store.compareAndSet({ key: 'never/created', expectedRevision: 'r99', operationId: 'op_x', next: { value: 'x', expiresAt: null } });
    expect(result).toEqual({ kind: 'conflict', current: null });
    expect(await store.read('never/created')).toEqual({ kind: 'absent' });
  });

  it('a lost response is outcome_unknown to the caller that experienced it, then resolves and retries as applied', async () => {
    const { store, records } = makeStore();
    records.loseResponseOnNextSet();
    const first = await store.compareAndSet({ key: 'invite/7', expectedRevision: null, operationId: 'op_share', next: { value: { roomId: 'demo' }, expiresAt: null } });
    expect(first).toEqual({ kind: 'outcome_unknown', operationId: 'op_share' });

    const resolved = await store.resolve({ key: 'invite/7', operationId: 'op_share' });
    expect(resolved).toMatchObject({ kind: 'applied', record: { value: { roomId: 'demo' } } });

    const retry = await store.compareAndSet({ key: 'invite/7', expectedRevision: null, operationId: 'op_share', next: { value: { roomId: 'demo' }, expiresAt: null } });
    expect(retry).toMatchObject({ kind: 'applied', record: { value: { roomId: 'demo' } } });
  });

  it('an identical retry with reordered object keys is recognized as the same write', async () => {
    const { store } = makeStore();
    await store.compareAndSet({ key: 'k/reorder', expectedRevision: null, operationId: 'op_r', next: { value: { a: 1, b: 2 }, expiresAt: null } });
    const retry = await store.compareAndSet({ key: 'k/reorder', expectedRevision: null, operationId: 'op_r', next: { value: { b: 2, a: 1 }, expiresAt: null } });
    expect(retry).toMatchObject({ kind: 'applied', record: { value: { a: 1, b: 2 } } });
  });

  it('an operation ID cannot be reused with different bytes at the same key', async () => {
    const { store } = makeStore();
    await store.compareAndSet({ key: 'room/title', expectedRevision: null, operationId: 'op_cmd', next: { value: 'API review', expiresAt: null } });
    const mismatch = await store.compareAndSet({ key: 'room/title', expectedRevision: null, operationId: 'op_cmd', next: { value: 'Merge now', expiresAt: null } });
    expect(mismatch).toEqual({ kind: 'operation_mismatch' });
    expect(await store.read('room/title')).toMatchObject({ kind: 'record', record: { value: 'API review' } });
  });

  it('an operation ID cannot be reused at a different key: the second key is never written', async () => {
    const { store } = makeStore();
    await store.compareAndSet({ key: 'room/a/title', expectedRevision: null, operationId: 'op_cmd', next: { value: 'API review', expiresAt: null } });
    const mismatch = await store.compareAndSet({ key: 'room/b/title', expectedRevision: null, operationId: 'op_cmd', next: { value: 'API review', expiresAt: null } });
    expect(mismatch).toEqual({ kind: 'operation_mismatch' });
    expect(await store.read('room/b/title')).toEqual({ kind: 'absent' });
  });

  it('same operation ID with changed expiresAt also fails as operation_mismatch', async () => {
    const { store } = makeStore();
    await store.compareAndSet({ key: 'room/title2', expectedRevision: null, operationId: 'op_cmd2', next: { value: 'API review', expiresAt: null } });
    const mismatch = await store.compareAndSet({ key: 'room/title2', expectedRevision: null, operationId: 'op_cmd2', next: { value: 'API review', expiresAt: '2026-09-17T00:00:00Z' } });
    expect(mismatch).toEqual({ kind: 'operation_mismatch' });
  });

  it('an expired record never authorizes a read, and a fresh create-if-absent may overwrite it', async () => {
    const { store, setClock } = makeStore(1789560000000);
    const created = await store.compareAndSet({
      key: 'invite/8', expectedRevision: null, operationId: 'op_i8', next: { value: { roomId: 'demo' }, expiresAt: '2026-09-16T12:00:01Z' },
    });
    expect(created.kind).toBe('applied');
    expect(await store.read('invite/8')).toMatchObject({ kind: 'record', record: { value: { roomId: 'demo' } } });

    setClock(1789560001000);
    expect(await store.read('invite/8')).toEqual({ kind: 'absent' });

    const recreated = await store.compareAndSet({
      key: 'invite/8', expectedRevision: null, operationId: 'op_i8b', next: { value: { roomId: 'other' }, expiresAt: null },
    });
    expect(recreated).toMatchObject({ kind: 'applied', record: { value: { roomId: 'other' } } });
  });

  it('a read outage is unavailable, never mistaken for absence', async () => {
    const { store, records } = makeStore();
    records.failNext('definite');
    expect(await store.read('membership/bob')).toEqual({ kind: 'unavailable' });
    expect(await store.read('membership/bob')).toEqual({ kind: 'absent' });
  });

  it('a definite (server-reported) write rejection is unavailable, and nothing was written', async () => {
    const { store, operations } = makeStore();
    operations.failNext('definite');
    const result = await store.compareAndSet({ key: 'membership/bob', expectedRevision: null, operationId: 'op_m', next: { value: 'joined', expiresAt: null } });
    expect(result).toEqual({ kind: 'unavailable' });
    expect(await store.read('membership/bob')).toEqual({ kind: 'absent' });
  });

  it('an ambiguous (network-level) failure during the primary write is outcome_unknown, not unavailable', async () => {
    const { store, records } = makeStore();
    records.failNext('ambiguous');
    const result = await store.compareAndSet({ key: 'membership/carol', expectedRevision: null, operationId: 'op_c2', next: { value: 'joined', expiresAt: null } });
    expect(result).toEqual({ kind: 'outcome_unknown', operationId: 'op_c2' });
  });

  describe('resolve', () => {
    it('reports not_applied for a write that never landed', async () => {
      const { store } = makeStore();
      expect(await store.resolve({ key: 'k/never', operationId: 'op_never' })).toEqual({ kind: 'not_applied' });
    });

    it('reports outcome_unknown when a different operation now occupies the key', async () => {
      const { store } = makeStore();
      await store.compareAndSet({ key: 'k/shared', expectedRevision: null, operationId: 'op_first', next: { value: 'a', expiresAt: null } });
      expect(await store.resolve({ key: 'k/shared', operationId: 'op_stale' })).toEqual({ kind: 'outcome_unknown', operationId: 'op_stale' });
    });

    it('reports unavailable on a read outage rather than guessing', async () => {
      const { store, records } = makeStore();
      records.failNext('definite');
      expect(await store.resolve({ key: 'k/x', operationId: 'op_x' })).toEqual({ kind: 'unavailable' });
    });
  });
});

function never(): never {
  throw new Error('unreachable');
}
