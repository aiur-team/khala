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
  private nextRejection: 'definite' | 'ambiguous' | 'server-error' | 'out-of-allowlist-4xx' | null = null;
  private lostResponseOnNextSet = false;
  private beforeNextSet: (() => void) | null = null;

  /**
   * `definite`: an explicit 4xx the provider round-tripped — the only mode
   * that proves nothing committed. `server-error`: an explicit 5xx — still
   * ambiguous, because the provider's own write can commit before it fails to
   * report success. `ambiguous`: no status at all (a network-level throw).
   * `out-of-allowlist-4xx`: a real `@netlify/blobs` `BlobsInternalError`,
   * which sets `status` to the underlying response's status — here a 408,
   * outside the definite-rejection allowlist — still ambiguous, not `definite`.
   */
  failNext(mode: 'definite' | 'ambiguous' | 'server-error' | 'out-of-allowlist-4xx'): void {
    this.nextRejection = mode;
  }

  /** Simulates a write that lands server-side but whose response never reaches this caller. */
  loseResponseOnNextSet(): void {
    this.lostResponseOnNextSet = true;
  }

  /** Runs `fn` immediately before the next `setJSON` evaluates its precondition, simulating a concurrent writer that lands in the gap between a `read` and a `write`. */
  raceBeforeNextSet(fn: () => void): void {
    this.beforeNextSet = fn;
  }

  private nullifyNextGet: string | null = null;

  /** Makes the next `getWithMetadata` for this exact key return null once, simulating an entry that vanished between two round trips. */
  returnNullOnceFor(key: string): void {
    this.nullifyNextGet = key;
  }

  /** Writes directly, bypassing CAS — only for simulating a concurrent writer via `raceBeforeNextSet`. */
  rawWrite(key: string, data: unknown): void {
    this.revision += 1;
    this.entries.set(key, { data, etag: `r${this.revision}` });
  }

  private throwRejection(mode: 'definite' | 'ambiguous' | 'server-error' | 'out-of-allowlist-4xx'): never {
    if (mode === 'definite') {
      const error = new Error('bad request') as Error & { status: number };
      error.status = 400;
      throw error;
    }
    if (mode === 'server-error') {
      const error = new Error('BlobsInternalError') as Error & { status: number };
      error.status = 503;
      throw error;
    }
    if (mode === 'out-of-allowlist-4xx') {
      const error = new Error('BlobsInternalError') as Error & { status: number };
      error.status = 408;
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
    if (this.nullifyNextGet === key) {
      this.nullifyNextGet = null;
      return null;
    }
    const entry = this.entries.get(key);
    return entry ? { data: entry.data, etag: entry.etag } : null;
  }

  async setJSON(key: string, data: unknown, options: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}): Promise<{ modified: boolean; etag?: string }> {
    this.consumePreflightFailure();
    if (this.beforeNextSet) {
      const fn = this.beforeNextSet;
      this.beforeNextSet = null;
      fn();
    }
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

  it('an ambiguous failure claiming the operation ledger is also outcome_unknown', async () => {
    const { store, operations } = makeStore();
    operations.failNext('ambiguous');
    const result = await store.compareAndSet({ key: 'membership/dave', expectedRevision: null, operationId: 'op_d1', next: { value: 'joined', expiresAt: null } });
    expect(result).toEqual({ kind: 'outcome_unknown', operationId: 'op_d1' });
  });

  it('a server-reported 5xx during the primary write is outcome_unknown, not unavailable: the provider can commit before it fails to report success', async () => {
    const { store, records } = makeStore();
    records.failNext('server-error');
    const result = await store.compareAndSet({ key: 'membership/erin', expectedRevision: null, operationId: 'op_e1', next: { value: 'joined', expiresAt: null } });
    expect(result).toEqual({ kind: 'outcome_unknown', operationId: 'op_e1' });
  });

  it('a server-reported 5xx on read is unavailable, not a false absence', async () => {
    const { store, records } = makeStore();
    records.failNext('server-error');
    expect(await store.read('membership/frank')).toEqual({ kind: 'unavailable' });
  });

  it('an out-of-allowlist 4xx (e.g. a BlobsInternalError reporting 408) during the primary write is outcome_unknown, not unavailable', async () => {
    const { store, records } = makeStore();
    records.failNext('out-of-allowlist-4xx');
    const result = await store.compareAndSet({ key: 'membership/gabe', expectedRevision: null, operationId: 'op_g1', next: { value: 'joined', expiresAt: null } });
    expect(result).toEqual({ kind: 'outcome_unknown', operationId: 'op_g1' });
  });

  it('a retry after a lost write that was then legitimately superseded is outcome_unknown, never a false conflict', async () => {
    const { store, records } = makeStore();
    const key = 'invite/superseded';
    const operationId = 'op_first';
    records.loseResponseOnNextSet();
    const first = await store.compareAndSet({ key, expectedRevision: null, operationId, next: { value: 'mine', expiresAt: null } });
    expect(first).toEqual({ kind: 'outcome_unknown', operationId });

    // The lost write actually landed, and a second, unrelated operation then
    // legitimately overwrote it using a correct CAS against that etag.
    const current = await store.read<string>(key);
    expect(current).toMatchObject({ kind: 'record', record: { value: 'mine' } });
    const revision = current.kind === 'record' ? current.record.revision : never();
    const superseded = await store.compareAndSet({ key, expectedRevision: revision, operationId: 'op_second', next: { value: 'theirs', expiresAt: null } });
    expect(superseded.kind).toBe('applied');

    // The original caller, unaware it was superseded, retries with its own
    // original operation ID, content and (now-stale) expectedRevision. The
    // ledger already recorded op_first's claim, so this cannot be reported as
    // a fresh conflict — op_first's own effect on the key can't be disproved.
    const retry = await store.compareAndSet({ key, expectedRevision: null, operationId, next: { value: 'mine', expiresAt: null } });
    expect(retry).toEqual({ kind: 'outcome_unknown', operationId });
  });

  it('a retry whose own write races a third writer during the CAS attempt is outcome_unknown, never a false conflict', async () => {
    const { store, records } = makeStore();
    const key = 'invite/retry-races-write';
    const operationId = 'op_first';

    const created = await store.compareAndSet({ key, expectedRevision: null, operationId, next: { value: 'v1', expiresAt: null } });
    expect(created.kind).toBe('applied');

    const revisionAfterFirst = created.kind === 'applied' ? created.record.revision : never();
    const superseded = await store.compareAndSet({ key, expectedRevision: revisionAfterFirst, operationId: 'op_second', next: { value: 'v2', expiresAt: null } });
    expect(superseded.kind).toBe('applied');
    const revisionAfterSecond = superseded.kind === 'applied' ? superseded.record.revision : never();

    // The original caller retries op_first (same operation ID and content, so
    // the ledger already holds this exact claim) against the now-current
    // revision. Between its read and its own CAS write, a third writer lands.
    records.raceBeforeNextSet(() => records.rawWrite(key, { operationId: 'op_third', value: 'v3', expiresAt: null }));
    const retry = await store.compareAndSet({ key, expectedRevision: revisionAfterSecond, operationId, next: { value: 'v1', expiresAt: null } });

    // The precondition fails against op_third's write, and the readback shows
    // op_third rather than our own retried write — but op_first's ledger claim
    // means an earlier invocation's effect can't be disproved, so this must
    // not be reported as a fresh conflict.
    expect(retry).toEqual({ kind: 'outcome_unknown', operationId });
    expect(await store.read(key)).toMatchObject({ kind: 'record', record: { value: 'v3', operationId: 'op_third' } });
  });

  it('a ledger entry that vanishes between the failed claim attempt and its readback is unknown, never counted as claimed', async () => {
    const { store, operations } = makeStore();
    const key = 'invite/vanishing-ledger';
    const operationId = 'op_vanish';
    // Pre-populate the ledger so the initial onlyIfNew claim attempt fails and
    // falls through to a readback, then make that readback see nothing.
    operations.rawWrite(operationId, { key, digest: 'stale-digest-does-not-matter' });
    operations.returnNullOnceFor(operationId);

    const result = await store.compareAndSet({ key, expectedRevision: null, operationId, next: { value: 'x', expiresAt: null } });
    expect(result).toEqual({ kind: 'outcome_unknown', operationId });
  });

  it('a value that is not valid JSON (e.g. undefined) is read as unavailable, never as a live record', async () => {
    const { store, records } = makeStore();
    const key = 'corrupt/undefined-value';
    records.rawWrite(key, { operationId: 'op_corrupt', value: undefined, expiresAt: null });
    expect(await store.read(key)).toEqual({ kind: 'unavailable' });
  });

  it('a corrupt (undecodable) stored record is unavailable, never treated as absent and silently overwritable', async () => {
    const { store, records } = makeStore();
    const key = 'corrupt/missing-operation-id';
    records.rawWrite(key, { notAnEnvelope: true });
    expect(await store.read(key)).toEqual({ kind: 'unavailable' });
  });

  it('a concurrent writer landing between our read and our write, using our own operation ID and content, is discovered as applied via readback', async () => {
    const { store, records } = makeStore();
    const key = 'race/same-write';
    const operationId = 'op_race';
    records.raceBeforeNextSet(() => records.rawWrite(key, { operationId, value: 'x', expiresAt: null }));
    const result = await store.compareAndSet({ key, expectedRevision: null, operationId, next: { value: 'x', expiresAt: null } });
    expect(result).toMatchObject({ kind: 'applied', record: { value: 'x', operationId } });
  });

  it('a concurrent writer landing between our read and our write, using a different operation ID, is reported as a conflict rather than applied', async () => {
    const { store, records } = makeStore();
    const key = 'race/different-write';
    records.raceBeforeNextSet(() => records.rawWrite(key, { operationId: 'op_other', value: 'other', expiresAt: null }));
    const result = await store.compareAndSet({ key, expectedRevision: null, operationId: 'op_mine', next: { value: 'mine', expiresAt: null } });
    expect(result).toMatchObject({ kind: 'conflict', current: { value: 'other', operationId: 'op_other' } });
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

    it('reports applied for the caller\'s own write even after it has since expired, rather than licensing a re-apply', async () => {
      const { store, setClock } = makeStore(1789560000000);
      await store.compareAndSet({
        key: 'k/expired-own', expectedRevision: null, operationId: 'op_own',
        next: { value: 'mine', expiresAt: '2026-09-16T12:00:01Z' },
      });
      setClock(1789560001000);
      expect(await store.read('k/expired-own')).toEqual({ kind: 'absent' });
      expect(await store.resolve({ key: 'k/expired-own', operationId: 'op_own' })).toMatchObject({ kind: 'applied', record: { value: 'mine' } });
    });

    it('reports outcome_unknown, not not_applied, when a different operation\'s now-expired write occupies the key', async () => {
      const { store, setClock } = makeStore(1789560000000);
      await store.compareAndSet({
        key: 'k/expired-other', expectedRevision: null, operationId: 'op_other',
        next: { value: 'theirs', expiresAt: '2026-09-16T12:00:01Z' },
      });
      setClock(1789560001000);
      expect(await store.resolve({ key: 'k/expired-other', operationId: 'op_mine' })).toEqual({ kind: 'outcome_unknown', operationId: 'op_mine' });
    });
  });
});

function never(): never {
  throw new Error('unreachable');
}
