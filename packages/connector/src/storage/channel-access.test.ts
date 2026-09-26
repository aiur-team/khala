// The activation journal on the real owner-local ledger: migration, compare-and-set,
// record/key atomicity, owner-only file mode and restart resumption.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StableAgentPrincipal } from '@khala/contracts/messaging/index';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivationRecord } from '../bootstrap/channel-access-activation';
import { createChannelAccessActivationStore } from './channel-access';
import { limits, scratchDirectory } from './fixtures/fakes';
import { LEDGER_FILE } from './leases';
import { type ConnectorStorage, openConnectorStorage } from './open';
import { SCHEMA_VERSION } from './schema';

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

const PENDING: ActivationRecord = {
  v: 1,
  operationId: 'op_access_1',
  requester: 'principal_1' as StableAgentPrincipal,
  origin: 'https://khala.example',
  sessionGeneration: 3,
  proofKeyThumbprint: 'P'.repeat(43),
  phase: 'pending',
  deviceId: null,
  recoveryPublicKey: null,
  recoveryKeyThumbprint: null,
  binding: null,
  recoverableUntil: null,
  repair: null,
  closed: null,
};

const KEYED: ActivationRecord = {
  ...PENDING,
  phase: 'keyed',
  deviceId: 'device_1',
  recoveryPublicKey: 'X'.repeat(43),
  recoveryKeyThumbprint: 'T'.repeat(43),
};

const PRIVATE_KEY = new Uint8Array(32).fill(7);

describe('channel-access activation storage', () => {
  it('commits a record and its recovery key together and reloads both after restart', async () => {
    const { storage, state } = await fresh();
    const store = createChannelAccessActivationStore(storage);
    expect(await store.save(PENDING, null, { kind: 'keep' })).toEqual({ kind: 'saved', revision: 1 });
    expect(await store.save(KEYED, 1, { kind: 'set', privateKey: PRIVATE_KEY })).toEqual({ kind: 'saved', revision: 2 });
    await storage.close();

    const reopened = createChannelAccessActivationStore(await open(state, 'existing'));
    const loaded = await reopened.load('op_access_1');
    expect(loaded).toEqual({ kind: 'record', record: KEYED, revision: 2, recoveryKey: PRIVATE_KEY });
    expect(await reopened.listActive()).toEqual(['op_access_1']);
  });

  it('keeps the private key out of the record JSON and the ledger owner-only', async () => {
    const { storage, state } = await fresh();
    const store = createChannelAccessActivationStore(storage);
    await store.save(KEYED, null, { kind: 'set', privateKey: PRIVATE_KEY });
    await storage.close();
    const file = path.join(state, LEDGER_FILE);
    expect(fs.statSync(state).mode & 0o077).toBe(0);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    const raw = new DatabaseSync(file, { readOnly: true });
    const row = raw.prepare('SELECT record, recovery_key FROM channel_access_activations').get() as { record: string; recovery_key: Uint8Array };
    raw.close();
    expect(row.record).not.toContain(Buffer.from(PRIVATE_KEY).toString('base64url'));
    expect(row.record).not.toContain('recovery_key');
    expect(new Uint8Array(row.recovery_key)).toEqual(PRIVATE_KEY);
  });

  it('compares and sets by revision and never lets the request tuple or device drift', async () => {
    const { storage } = await fresh();
    const store = createChannelAccessActivationStore(storage);
    await store.save(PENDING, null, { kind: 'keep' });
    expect(await store.save(PENDING, null, { kind: 'keep' })).toEqual({ kind: 'conflict' });
    expect(await store.save(KEYED, 7, { kind: 'keep' })).toEqual({ kind: 'conflict' });
    expect(await store.save({ ...KEYED, sessionGeneration: 4 }, 1, { kind: 'keep' })).toEqual({ kind: 'conflict' });
    expect(await store.save(KEYED, 1, { kind: 'set', privateKey: PRIVATE_KEY })).toMatchObject({ kind: 'saved' });
    expect(await store.save({ ...KEYED, deviceId: 'device_2' }, 2, { kind: 'keep' })).toEqual({ kind: 'conflict' });
    await expect(store.save({ ...KEYED, phase: 'connected' }, 2, { kind: 'keep' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.save(KEYED, 2, { kind: 'set', privateKey: new Uint8Array(16) })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('clears the key and drops terminal rows from resumption', async () => {
    const { storage } = await fresh();
    const store = createChannelAccessActivationStore(storage);
    await store.save(KEYED, null, { kind: 'set', privateKey: PRIVATE_KEY });
    await store.save({ ...KEYED, phase: 'closed', closed: 'denied' }, 1, { kind: 'clear' });
    expect(await store.load('op_access_1')).toMatchObject({ recoveryKey: null, record: { phase: 'closed' } });
    expect(await store.listActive()).toEqual([]);
  });

  it('refuses a corrupt row instead of guessing', async () => {
    const { storage, state } = await fresh();
    const store = createChannelAccessActivationStore(storage);
    await store.save(PENDING, null, { kind: 'keep' });
    await storage.close();
    const raw = new DatabaseSync(path.join(state, LEDGER_FILE));
    raw.prepare("UPDATE channel_access_activations SET phase = 'connected'").run();
    raw.close();
    const reopened = createChannelAccessActivationStore(await open(state, 'existing'));
    await expect(reopened.load('op_access_1')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('adds the activation journal to a version 4 ledger', async () => {
    const { storage, state } = await fresh();
    await storage.close();
    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    db.exec('DROP TABLE channel_access_activations; PRAGMA user_version = 4;');
    db.close();
    const reopened = await open(state, 'existing');
    expect(await createChannelAccessActivationStore(reopened).load('op_access_1')).toEqual({ kind: 'absent' });
    await reopened.close();
    const raw = new DatabaseSync(path.join(state, LEDGER_FILE), { readOnly: true });
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    raw.close();
  });
});
