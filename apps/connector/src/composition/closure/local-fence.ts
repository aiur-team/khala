import { createHash, randomUUID } from 'node:crypto';
import { link, open, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { ConnectorStorage } from '@khala/connector/storage/open';

export type LocalStopRequest = Readonly<{
  operationId: string; ownerId: string; roomId: string; expectedRoomRevision: number;
}>;
export type LocalStopReceipt = LocalStopRequest & Readonly<{
  bindingId: string; bindingGeneration: number; state: 'stopped'; cleanupRequested: true;
}>;

/**
 * Stops ingress and waits for in-flight model dispatch before writing a permanent
 * ledger revocation. A receipt requires a synced, endpoint-local cleanup request.
 * If any step fails, hosted closure remains pending; retry is safe after a crash.
 */
export function createLocalClosureFence(input: Readonly<{
  storage: ConnectorStorage;
  binding: SessionBinding;
  roomId: string;
  stateDirectory: string;
  quiesce(): Promise<void>;
  clock(): number;
}>): Readonly<{ stop(request: LocalStopRequest): Promise<Readonly<{ kind: 'stopped'; receipt: LocalStopReceipt }> | Readonly<{ kind: 'unavailable' }>> }> {
  const { binding, roomId } = input;
  async function stop(request: LocalStopRequest) {
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(request.operationId) || request.ownerId !== binding.ownerId
      || request.roomId !== roomId || request.expectedRoomRevision !== 0) return { kind: 'unavailable' as const };
    try {
      await input.quiesce();
      await input.storage.ledger.transaction(tx => tx.putRevocation({
        targetKind: 'binding', targetId: binding.bindingId, generation: binding.generation,
        operationId: request.operationId, revokedAt: new Date(input.clock()).toISOString(),
      }));
      const directory = path.join(input.stateDirectory, 'closure-cleanup');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${createHash('sha256').update(JSON.stringify([
        request.operationId, binding.bindingId, binding.generation,
      ])).digest('hex')}.json`);
      const value = JSON.stringify({ v: 1, ...request, bindingId: binding.bindingId, bindingGeneration: binding.generation,
        cleanup: 'requested' });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
        try { await link(temporary, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const directoryHandle = await open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } finally { await rm(temporary, { force: true }); }
      if (await readFile(file, 'utf8') !== value) return { kind: 'unavailable' as const };
      const receipt: LocalStopReceipt = { ...request, bindingId: binding.bindingId,
        bindingGeneration: binding.generation, state: 'stopped', cleanupRequested: true };
      return { kind: 'stopped' as const, receipt };
    } catch { return { kind: 'unavailable' as const }; }
  }
  return { stop };
}
