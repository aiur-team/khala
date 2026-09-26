import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BindingId } from '@khala/contracts/delivery/index';
import { limits, scratchDirectory } from './fixtures/fakes';
import { createHarnessSelectionStore } from './harness-selection';
import { LEDGER_FILE } from './leases';
import type { ConnectorStorage } from './open';
import { openConnectorStorage } from './open';
import { SCHEMA_VERSION } from './schema';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];
const bindingId = 'binding-route-selection-1' as BindingId;
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');

beforeAll(() => {
  // The managed test workspace has synthetic ancestor ownership; lease ownership
  // behavior is covered by open.test.ts, while these tests exercise route durability.
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
});

afterAll(() => {
  if (getuid) Object.defineProperty(process, 'getuid', getuid);
  if (getgid) Object.defineProperty(process, 'getgid', getgid);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fresh() {
  const { parent, state } = scratchDirectory();
  scratch.push(parent);
  const storage = await openConnectorStorage({ directory: state, mode: 'create', limits });
  opened.push(storage);
  return { state, storage };
}

async function reopen(storage: ConnectorStorage, state: string) {
  await storage.close();
  const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
  opened.push(reopened);
  return reopened;
}

describe('durable harness route selection', () => {
  it('persists matching and generation-fenced route decisions across restart', async () => {
    const { state, storage } = await fresh();
    let selections = createHarnessSelectionStore(storage);
    expect(await selections.record({ bindingId, generation: 4, routeId: 'codex-native' })).toBe('stored');

    let reopened = await reopen(storage, state);
    selections = createHarnessSelectionStore(reopened);
    expect(await selections.record({ bindingId, generation: 4, routeId: 'codex-native' })).toBe('matched');
    expect(await selections.record({ bindingId, generation: 4, routeId: 'khala-skill' })).toBe('route_changed');
    expect(await selections.record({ bindingId, generation: 5, routeId: 'khala-skill' })).toBe('stored');

    reopened = await reopen(reopened, state);
    selections = createHarnessSelectionStore(reopened);
    expect(await selections.record({ bindingId, generation: 4, routeId: 'codex-native' })).toBe('stale_generation');
    expect(await selections.record({ bindingId, generation: 5, routeId: 'khala-skill' })).toBe('matched');
  });

  it('migrates a synthetic v2 ledger and preserves existing state', async () => {
    const { state, storage } = await fresh();
    await storage.commitCursor({ streamId: 'stream-before-v3', expectedRevision: 0, opaqueCursor: 'cursor-before-v3' });
    await storage.close();

    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    db.exec(`
      DROP TABLE receipt_outbox;
      DROP TABLE harness_route_selections;
      PRAGMA user_version = 2;
    `);
    db.close();

    const migrated = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(migrated);
    expect(await migrated.readCursor('stream-before-v3')).toEqual({ revision: 1, opaqueCursor: 'cursor-before-v3' });
    expect(await createHarnessSelectionStore(migrated).record({
      bindingId,
      generation: 1,
      routeId: 'codex-native',
    })).toBe('stored');
    await migrated.close();

    const migratedDb = new DatabaseSync(path.join(state, LEDGER_FILE), { readOnly: true });
    expect(migratedDb.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    migratedDb.close();
  });
});
