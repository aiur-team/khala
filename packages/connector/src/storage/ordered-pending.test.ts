import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import { openConnectorStorage, type ConnectorStorage } from './open';
import { readOrderedPendingReferences } from './ordered-pending';
import { binding, limits, pendingInput, scratchDirectory, unavailableInput } from './fixtures/fakes';

const opened: ConnectorStorage[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
it('keeps original intake position when missing-key text is decrypted later, and isolates generations', async () => {
  const directory = scratchDirectory(); directories.push(directory.parent);
  const storage = await openConnectorStorage({ directory: directory.state, mode: 'create', limits }); opened.push(storage);
  await storage.ledger.transaction(tx => tx.putBinding(binding()));
  await storage.persistUnavailable(unavailableInput('event-first'));
  await storage.persistPending(pendingInput('event-second', 'private-second'));
  await storage.persistPending(pendingInput('event-first', 'private-first'));
  const records = readOrderedPendingReferences(storage, binding());
  expect(records.map(row => row.eventId)).toEqual(['event-first', 'event-second']);
  expect(JSON.stringify(records)).not.toContain('private');
  expect(readOrderedPendingReferences(storage, binding(1))).toEqual([]);
});
