import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteControlStore } from './control-store';
import { type InternalStoreHandle, openChannelStore } from './open';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-control-store-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  return path.join(root, 'state');
}

function open(target: string, mode: 'create' | 'existing' = 'create'): InternalStoreHandle {
  const handle = openChannelStore({ directory: target, mode });
  handles.push(handle);
  return handle;
}

describe('SQLite ControlStore', () => {
  it('creates, compares and sets by revision, and replays an identical operation', async () => {
    let now = Date.parse('2026-09-25T12:00:00Z');
    const store = createSqliteControlStore(open(directory()), () => now);
    expect(await store.read('k')).toEqual({ kind: 'absent' });
    const next = { value: { b: [1, 2], a: 'x' }, expiresAt: null };
    const first = await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op1', next });
    expect(first.kind).toBe('applied');
    if (first.kind !== 'applied') throw new Error('unreachable');
    // Key order is irrelevant to replay; different bytes are an operation mismatch.
    expect(await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op1', next: { value: { a: 'x', b: [1, 2] }, expiresAt: null } }))
      .toEqual(first);
    expect(await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op1', next: { value: 1, expiresAt: null } }))
      .toEqual({ kind: 'operation_mismatch' });
    expect(await store.compareAndSet({ key: 'other', expectedRevision: null, operationId: 'op1', next }))
      .toEqual({ kind: 'operation_mismatch' });
    const stale = await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op2', next: { value: 2, expiresAt: null } });
    expect(stale).toEqual({ kind: 'conflict', current: first.record });
    const second = await store.compareAndSet({
      key: 'k', expectedRevision: first.record.revision, operationId: 'op3', next: { value: 3, expiresAt: '2026-09-25T12:01:00Z' },
    });
    expect(second).toMatchObject({ kind: 'applied', record: { value: 3, operationId: 'op3' } });
    expect(await store.resolve({ key: 'k', operationId: 'op3' })).toEqual(second);
    expect(await store.resolve({ key: 'k', operationId: 'op2' })).toEqual({ kind: 'not_applied' });
    expect(await store.resolve({ key: 'other', operationId: 'op3' })).toEqual({ kind: 'not_applied' });
    now += 60_000;
    // Expired records read as absent and may be recreated from `null`.
    expect(await store.read('k')).toEqual({ kind: 'absent' });
    expect(await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op4', next: { value: 4, expiresAt: null } }))
      .toMatchObject({ kind: 'applied', record: { value: 4 } });
  });

  it('keeps records and operation claims across restart', async () => {
    const target = directory();
    const clock = () => Date.parse('2026-09-25T12:00:00Z');
    const first = open(target);
    const applied = await createSqliteControlStore(first, clock)
      .compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op1', next: { value: { v: 1 }, expiresAt: null } });
    first.close();
    const reopened = createSqliteControlStore(open(target, 'existing'), clock);
    expect(await reopened.read('k')).toEqual({ kind: 'record', record: (applied as { record: unknown }).record });
    expect(await reopened.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op1', next: { value: { v: 1 }, expiresAt: null } }))
      .toEqual(applied);
  });

  it('reports a closed store as unavailable or unknown, never absent or applied', async () => {
    const handle = open(directory());
    const store = createSqliteControlStore(handle, Date.now);
    handle.close();
    expect(await store.read('k')).toEqual({ kind: 'unavailable' });
    expect(await store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next: { value: 1, expiresAt: null } }))
      .toEqual({ kind: 'outcome_unknown', operationId: 'op' });
    expect(await store.resolve({ key: 'k', operationId: 'op' })).toEqual({ kind: 'unavailable' });
  });
});
