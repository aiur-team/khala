// Durable bootstrap state uses the real owner-local ledger so restart tests cover
// SQLite migration, compare-and-set, and key material rather than an in-memory double.

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '@khala/contracts/delivery/index';
import type { OperationRecord } from '../bootstrap/ports';
import {
  createBootstrapOperationStore, loadOrCreateBootstrapSigner,
} from './bootstrap';
import { binding, limits, scratchDirectory } from './fixtures/fakes';
import { type ConnectorStorage, openConnectorStorage, storageInternals } from './open';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function open(directory: string, mode: 'create' | 'existing' = 'create') {
  const storage = await openConnectorStorage({ directory, mode, limits });
  opened.push(storage);
  return storage;
}

async function fresh() {
  const { parent, state } = scratchDirectory();
  scratch.push(parent);
  return { state, storage: await open(state) };
}

async function reopen(storage: ConnectorStorage, state: string) {
  await storage.close();
  return open(state, 'existing');
}

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    v: 1,
    operationId: 'bootstrap-operation-1',
    fingerprint: 'sha256:bootstrap-input-1',
    phase: 'reserved',
    deviceId: 'device_connector_b',
    binding: null,
    ...overrides,
  };
}

describe('bootstrap persistence', () => {
  it('persists one Ed25519 signer and reopens with the same public thumbprint', async () => {
    const { state, storage } = await fresh();
    const first = await loadOrCreateBootstrapSigner(storage, () => 1_000);
    const reopened = await reopen(storage, state);
    const second = await loadOrCreateBootstrapSigner(reopened, () => 2_000);

    expect(second.jkt).toBe(first.jkt);
    expect(second.proof('POST', 'https://khala.example/redeem')).not.toBe(first.proof('POST', 'https://khala.example/redeem'));
  });

  it('fails closed when persisted signer bytes are corrupt or not Ed25519', async () => {
    const { state, storage } = await fresh();
    await loadOrCreateBootstrapSigner(storage);
    const internals = storageInternals.get(storage);
    if (!internals) throw new Error('missing storage internals');
    internals.ctx.db.prepare('UPDATE bootstrap_signer SET private_key = ? WHERE singleton = 1')
      .run(new Uint8Array([115, 101, 99, 114, 101, 116]));

    const reopened = await reopen(storage, state);
    await expect(loadOrCreateBootstrapSigner(reopened)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(loadOrCreateBootstrapSigner(reopened)).rejects.not.toThrow(/secret/i);
  });

  it('uses row revisions for CAS, rejects changed fingerprints, and survives every phase', async () => {
    const { state, storage } = await fresh();
    let store = createBootstrapOperationStore(storage);
    const reserved = operation();
    expect(await store.save(reserved, null)).toEqual({ kind: 'saved', revision: 1 });
    expect(await store.save(reserved, null)).toEqual({ kind: 'conflict' });

    const admitted = operation({ phase: 'admitted', binding: binding(0) });
    expect(await store.save(admitted, 1)).toEqual({ kind: 'saved', revision: 2 });
    expect(await store.save(operation({ fingerprint: 'sha256:different' }), 2)).toEqual({ kind: 'conflict' });
    expect(await store.save(operation({ phase: 'repair_required', binding: binding(0) }), 1)).toEqual({ kind: 'conflict' });

    let reopened = await reopen(storage, state);
    store = createBootstrapOperationStore(reopened);
    expect(await store.load(reserved.operationId)).toEqual({ kind: 'record', record: admitted, revision: 2 });

    const repair = operation({ phase: 'repair_required', binding: binding(0) });
    expect(await store.save(repair, 2)).toEqual({ kind: 'saved', revision: 3 });
    reopened = await reopen(reopened, state);
    store = createBootstrapOperationStore(reopened);
    expect(await store.load(reserved.operationId)).toEqual({ kind: 'record', record: repair, revision: 3 });

    const connected = operation({ phase: 'connected', binding: binding(0) });
    expect(await store.save(connected, 3)).toEqual({ kind: 'saved', revision: 4 });
    reopened = await reopen(reopened, state);
    expect(await createBootstrapOperationStore(reopened).load(reserved.operationId))
      .toEqual({ kind: 'record', record: connected, revision: 4 });
  });

  it('does not make an interrupted pre-bind bootstrap ledger look adoptable stateful', async () => {
    const { state, storage } = await fresh();
    await loadOrCreateBootstrapSigner(storage);
    expect(await createBootstrapOperationStore(storage).save(operation(), null)).toEqual({ kind: 'saved', revision: 1 });

    const reopened = await reopen(storage, state);
    expect(await reopened.bindDeviceIdentity({
      deviceId: 'device_connector_b' as DeviceId,
      fingerprint: 'device-fingerprint-1',
    })).toEqual({ kind: 'bound' });
  });

  it('fences bootstrap adapters after a device identity conflict', async () => {
    const { storage } = await fresh();
    const identity = { deviceId: 'device_connector_b' as DeviceId, fingerprint: 'device-fingerprint-1' };
    expect(await storage.bindDeviceIdentity(identity)).toEqual({ kind: 'bound' });
    expect(await storage.bindDeviceIdentity({ ...identity, fingerprint: 'device-fingerprint-2' }))
      .toEqual({ kind: 'conflict', code: 'identity_mismatch' });

    await expect(createBootstrapOperationStore(storage).load('bootstrap-operation-1'))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(loadOrCreateBootstrapSigner(storage)).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it('rejects malformed stored operation state without returning its contents', async () => {
    const { storage } = await fresh();
    const store = createBootstrapOperationStore(storage);
    expect(await store.save(operation(), null)).toEqual({ kind: 'saved', revision: 1 });
    const internals = storageInternals.get(storage);
    if (!internals) throw new Error('missing storage internals');
    internals.ctx.db.prepare('UPDATE bootstrap_operations SET record = ?').run('{"secret":"plaintext"}');

    await expect(store.load(operation().operationId)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(store.load(operation().operationId)).rejects.not.toThrow(/plaintext/);
  });
});
