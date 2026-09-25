import { describe, expect, it, vi } from 'vitest';
import { decodeSessionBinding, type BindingId, type SessionBinding } from '@khala/contracts/delivery/index';
import type { InboxBatch, InboxConsumer } from '../cli/inbox.js';
import { ReadOperation } from './read.js';

const decoded = decodeSessionBinding({
  v: 1, bindingId: 'binding-1', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'codex', sessionId: 'session-1', generation: 3,
});
if (!decoded.ok) throw new Error('invalid binding fixture');
const BINDING = decoded.value;
const BATCH = { token: 'batch-token', items: [] } as unknown as InboxBatch;

function replacement(overrides: Record<string, unknown> = { generation: 4 }): SessionBinding {
  const candidate = decodeSessionBinding({ ...BINDING, ...overrides });
  if (!candidate.ok) throw new Error('invalid replacement binding fixture');
  return candidate.value;
}

function consumer(readBatch: InboxConsumer['readBatch'] = vi.fn(async () => BATCH)): InboxConsumer {
  return { readBatch, release: vi.fn(async () => undefined) };
}

describe('ReadOperation', () => {
  it('returns the exact selected batch without owning or releasing the consumer', async () => {
    const readBatch = vi.fn(async () => BATCH);
    const held = consumer(readBatch);
    const currentBinding = vi.fn(async () => BINDING);
    const operation = new ReadOperation({ heldBinding: BINDING, consumer: held, currentBinding });

    await expect(operation.read({ bindingId: null, maxBytes: 4096 })).resolves.toEqual({ kind: 'batch', batch: BATCH });

    expect(readBatch).toHaveBeenCalledWith({ maxBytes: 4096 });
    expect(currentBinding).toHaveBeenCalledTimes(2);
    expect(held.release).not.toHaveBeenCalled();
  });

  it('passes only an explicitly supplied acknowledgement token to the inbox', async () => {
    const readBatch = vi.fn(async () => null);
    const operation = new ReadOperation({
      heldBinding: BINDING, consumer: consumer(readBatch), currentBinding: async () => BINDING,
    });

    await expect(operation.read({ bindingId: BINDING.bindingId, acknowledgeToken: 'prior-token', maxBytes: 512 }))
      .resolves.toEqual({ kind: 'empty' });
    expect(readBatch).toHaveBeenCalledWith({ maxBytes: 512, acknowledgeToken: 'prior-token' });
  });

  it('rejects a foreign requested binding before touching status or the inbox', async () => {
    const readBatch = vi.fn(async () => BATCH);
    const currentBinding = vi.fn(async () => BINDING);
    const operation = new ReadOperation({ heldBinding: BINDING, consumer: consumer(readBatch), currentBinding });

    await expect(operation.read({ bindingId: 'binding-2' as BindingId, maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'binding_not_held' });
    expect(currentBinding).not.toHaveBeenCalled();
    expect(readBatch).not.toHaveBeenCalled();
  });

  it('fails closed before selection when any held-binding field drifts', async () => {
    for (const latest of [
      null,
      replacement({ bindingId: 'binding-2' }),
      replacement({ ownerId: 'owner-2' }),
      replacement({ agentParticipantId: 'agent-2' }),
      replacement({ deviceId: 'device-2' }),
      replacement({ harness: 'other-harness' }),
      replacement({ sessionId: 'session-2' }),
      replacement({ generation: 4 }),
    ]) {
      const readBatch = vi.fn(async () => BATCH);
      const operation = new ReadOperation({
        heldBinding: BINDING, consumer: consumer(readBatch), currentBinding: async () => latest,
      });
      await expect(operation.read({ bindingId: null, maxBytes: 1 }))
        .rejects.toMatchObject({ code: 'binding_not_held' });
      expect(readBatch).not.toHaveBeenCalled();
    }
  });

  it('suppresses a selected batch when the complete binding drifts afterward', async () => {
    const readBatch = vi.fn(async () => BATCH);
    const currentBinding = vi.fn()
      .mockResolvedValueOnce(BINDING)
      .mockResolvedValueOnce(replacement({ ownerId: 'owner-2' }));
    const operation = new ReadOperation({ heldBinding: BINDING, consumer: consumer(readBatch), currentBinding });

    await expect(operation.read({ bindingId: null, maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'binding_not_held' });
    expect(readBatch).toHaveBeenCalledOnce();
  });
});
