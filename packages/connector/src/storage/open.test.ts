// Opening, ownership and schema checks against a real on-disk ledger.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '@khala/contracts/delivery/index';
import type { StorageErrorCode } from './errors';
import { limits, scratchDirectory } from './fakes';
import { LEDGER_FILE } from './leases';
import { type ConnectorStorage, openConnectorStorage } from './open';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const dir of scratch.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function dirs() {
  const d = scratchDirectory();
  scratch.push(d.parent);
  return d;
}

async function open(directory: string, mode: 'create' | 'existing' = 'create', maxBytes?: number) {
  const storage = await openConnectorStorage({ directory, mode, limits, ...(maxBytes === undefined ? {} : { maxBytes }) });
  opened.push(storage);
  return storage;
}

async function openError(directory: string, mode: 'create' | 'existing' = 'create'): Promise<StorageErrorCode> {
  try {
    await open(directory, mode);
  } catch (error) {
    return (error as { code: StorageErrorCode }).code;
  }
  throw new Error('open unexpectedly succeeded');
}

const modeOf = (target: string) => fs.statSync(target).mode & 0o777;

describe('openConnectorStorage', () => {
  it('creates an owner-only state directory and ledger', async () => {
    const { state } = dirs();
    await open(state);
    expect(modeOf(state)).toBe(0o700);
    expect(modeOf(path.join(state, LEDGER_FILE))).toBe(0o600);
    for (const name of fs.readdirSync(state)) expect(modeOf(path.join(state, name)) & 0o077).toBe(0);
  });

  it('refuses to invent state in existing mode', async () => {
    const { state } = dirs();
    expect(await openError(state, 'existing')).toBe('missing_state');
    fs.mkdirSync(state, { mode: 0o700 });
    expect(await openError(state, 'existing')).toBe('missing_state');
    expect(fs.readdirSync(state)).toEqual([]);
  });

  it('reopens existing state and bumps the open epoch each time', async () => {
    const { state } = dirs();
    const first = await open(state);
    expect(first.epoch).toBe(1);
    await first.close();
    const second = await open(state, 'existing');
    expect(second.epoch).toBe(2);
  });

  it('rejects relative, dot-segment and symlinked state paths', async () => {
    const { parent, state } = dirs();
    expect(await openError('relative/state')).toBe('unsafe_path');
    expect(await openError(`${parent}/x/../state`)).toBe('unsafe_path');

    fs.mkdirSync(path.join(parent, 'real'), { mode: 0o700 });
    fs.symlinkSync(path.join(parent, 'real'), state);
    expect(await openError(state)).toBe('unsafe_path');
  });

  it('rejects a symlinked or hard-linked ledger file', async () => {
    const { parent, state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    const elsewhere = path.join(parent, 'elsewhere.sqlite');
    fs.writeFileSync(elsewhere, '', { mode: 0o600 });
    fs.symlinkSync(elsewhere, path.join(state, LEDGER_FILE));
    expect(await openError(state)).toBe('unsafe_path');

    fs.unlinkSync(path.join(state, LEDGER_FILE));
    fs.linkSync(elsewhere, path.join(state, LEDGER_FILE));
    expect(await openError(state)).toBe('unsafe_path');
  });

  it('rejects state readable by other users', async () => {
    const { state } = dirs();
    await (await open(state)).close();
    fs.chmodSync(state, 0o750);
    expect(await openError(state, 'existing')).toBe('unsafe_path');
    fs.chmodSync(state, 0o700);
    fs.chmodSync(path.join(state, LEDGER_FILE), 0o644);
    expect(await openError(state, 'existing')).toBe('unsafe_path');
  });

  it('fails visibly when the state directory cannot be created', async () => {
    const { parent, state } = dirs();
    fs.chmodSync(parent, 0o500);
    expect(await openError(state)).toBe('io_failed');
  });

  it('refuses a corrupt ledger, a foreign SQLite file and a newer schema', async () => {
    const { state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    const file = path.join(state, LEDGER_FILE);
    fs.writeFileSync(file, 'not a sqlite database, just some bytes on disk'.repeat(4), { mode: 0o600 });
    expect(await openError(state, 'existing')).toBe('corrupt');

    fs.rmSync(file);
    const foreign = new DatabaseSync(file);
    foreign.exec('CREATE TABLE something_else (x)');
    foreign.close();
    fs.chmodSync(file, 0o600);
    expect(await openError(state, 'existing')).toBe('corrupt');

    fs.rmSync(file);
    await (await open(state)).close();
    const newer = new DatabaseSync(file);
    newer.exec('PRAGMA user_version = 99');
    newer.close();
    expect(await openError(state, 'existing')).toBe('schema_unsupported');
  });

  it('treats an empty ledger in existing mode as lost state, not a new one', async () => {
    const { state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, LEDGER_FILE), '', { mode: 0o600 });
    expect(await openError(state, 'existing')).toBe('corrupt');
    expect(fs.statSync(path.join(state, LEDGER_FILE)).size).toBe(0);
  });

  it('allows one owner at a time and releases ownership on close', async () => {
    const { state } = dirs();
    const first = await open(state);
    expect(await openError(state, 'existing')).toBe('locked');
    await first.close();
    await expect(first.readCursor('stream')).rejects.toMatchObject({ code: 'closed' });
    const second = await open(state, 'existing');
    expect(second.epoch).toBe(2);
  });

  it('binds the SDK device identity once and refuses a substitute', async () => {
    const { state } = dirs();
    const storage = await open(state);
    const identity = { deviceId: 'device_connector_b' as DeviceId, fingerprint: 'fp_1' };
    expect(await storage.bindDeviceIdentity(identity)).toEqual({ kind: 'bound' });
    await storage.close();

    const reopened = await open(state, 'existing');
    expect(await reopened.bindDeviceIdentity(identity)).toEqual({ kind: 'matched' });
    expect(await reopened.bindDeviceIdentity({ ...identity, fingerprint: 'fp_fresh' }))
      .toEqual({ kind: 'conflict', code: 'identity_mismatch' });
    expect(await reopened.bindDeviceIdentity({ ...identity, deviceId: 'device_new' as DeviceId }))
      .toEqual({ kind: 'conflict', code: 'identity_mismatch' });
  });
});
