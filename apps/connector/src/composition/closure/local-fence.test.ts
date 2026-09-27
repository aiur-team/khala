import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { openConnectorStorage } from '@khala/connector/storage/open';
import { createLocalClosureFence } from './local-fence';

const binding = { v: 1, bindingId: 'binding-one', ownerId: 'owner-one', agentParticipantId: 'agent-one',
  deviceId: 'device-one', harness: 'claude', sessionId: 'session-one', generation: 0 } as SessionBinding;
const request = { operationId: 'close_operation_one', ownerId: binding.ownerId,
  roomId: '!room:example', expectedRoomRevision: 0 };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-closure-'));
  directories.push(directory);
  const limits = decodeDeliveryLimits({ maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32 });
  if (!limits.ok) throw new Error('test limits invalid');
  const storage = await openConnectorStorage({ directory, mode: 'create', limits: limits.value });
  expect(await storage.ledger.transaction(tx => tx.putBinding(binding))).toMatchObject({ kind: 'inserted' });
  return { directory, storage };
}

describe('endpoint local closure fence', () => {
  it('waits for quiescence, permanently revokes the binding and persists a cleanup request before receipt', async () => {
    const { directory, storage } = await fixture();
    let quiesced = 0;
    const stop = createLocalClosureFence({ storage, binding, roomId: request.roomId, stateDirectory: directory,
      clock: () => Date.parse('2026-09-27T00:00:00Z'), quiesce: async () => { quiesced++; } });
    const first = await stop.stop(request);
    expect(first).toMatchObject({ kind: 'stopped', receipt: { bindingId: binding.bindingId, cleanupRequested: true } });
    expect(await stop.stop(request)).toEqual(first);
    expect(quiesced).toBe(2);
    expect(await storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: binding.bindingId, selection: [] })))
      .toEqual({ kind: 'revoked' });
    expect((await stop.stop({ ...request, ownerId: 'other-owner' })).kind).toBe('unavailable');
    await storage.close();
  });

  it('does not attest stop when the dispatcher could not quiesce', async () => {
    const { directory, storage } = await fixture();
    const stop = createLocalClosureFence({ storage, binding, roomId: request.roomId, stateDirectory: directory,
      clock: () => Date.parse('2026-09-27T00:00:00Z'), quiesce: async () => { throw new Error('in-flight'); } });
    expect(await stop.stop(request)).toEqual({ kind: 'unavailable' });
    expect(await storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: binding.bindingId, selection: [] })))
      .toMatchObject({ kind: 'snapshot' });
    await storage.close();
  });
});
