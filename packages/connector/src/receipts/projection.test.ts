// The drain loop against in-memory ports. Storage durability is covered where the real
// stores are composed (apps/internal); here the ports record the order of every call.

import { describe, expect, it } from 'vitest';
import type {
  BindingId, DeliveryReceiptV2, EventId, ReceiptId, ReleaseId, RoomId,
} from '@khala/contracts/delivery/index';
import type { OutboxEntry } from '../storage/acknowledgements';
import {
  type ProjectedReceipt, type ReceiptObservation, type ReceiptReadModel, RECEIPT_OBSERVATION_EVENT,
  createReceiptProjector, receiptObservation,
} from './projection';

function entry(release: string, revision: number, evidenceRef = `ack_${revision}`): OutboxEntry {
  const receipt: DeliveryReceiptV2 = {
    v: 2, receiptId: `receipt_${release}` as ReceiptId, releaseId: `release_${release}` as ReleaseId,
    bindingId: 'binding_a' as BindingId, generation: 0, kind: 'agent_acknowledged',
    observedAt: '2026-09-25T12:00:00Z', source: 'agent', evidenceRef, errorCode: null,
  };
  return {
    receipt, evidenceRef, ledgerRevision: revision,
    events: [{ roomId: 'room_1' as RoomId, eventId: `event_${release}` as EventId }],
  };
}

type Call = string;

function world(entries: readonly OutboxEntry[], faults: { failLogAt?: string; failCheckpointAt?: number } = {}) {
  const calls: Call[] = [];
  const facts = new Map<string, string>();
  const lines: ReceiptObservation[] = [];
  let checkpoint = 0;
  const readModel: ReceiptReadModel = {
    async projectReceipt(fact: ProjectedReceipt) {
      calls.push(`write ${fact.receipt.receiptId}`);
      const json = JSON.stringify(fact);
      const existing = facts.get(fact.receipt.receiptId);
      if (existing === undefined) {
        facts.set(fact.receipt.receiptId, json);
        return { kind: 'stored' };
      }
      return existing === json ? { kind: 'duplicate' } : { kind: 'conflict' };
    },
    async readCheckpoint() { return checkpoint; },
    async commitCheckpoint(revision) {
      calls.push(`checkpoint ${revision}`);
      if (faults.failCheckpointAt === revision) {
        delete faults.failCheckpointAt;
        throw new Error('crash before checkpoint');
      }
      checkpoint = Math.max(checkpoint, revision);
    },
  };
  const outbox = {
    pages: 0,
    async readReceiptOutbox(input: { afterRevision?: number; limit?: number } = {}) {
      this.pages += 1;
      return entries.filter(item => item.ledgerRevision > (input.afterRevision ?? 0)).slice(0, input.limit ?? 100);
    },
  };
  const log = {
    async record(observation: ReceiptObservation) {
      calls.push(`log ${observation.receiptId}`);
      if (faults.failLogAt === observation.receiptId) {
        delete faults.failLogAt;
        throw new Error('crash before log');
      }
      lines.push(observation);
    },
  };
  return { calls, facts, lines, outbox, readModel, log, checkpoint: () => checkpoint };
}

describe('receipt outbox projection', () => {
  it('writes the read model, then the log, then checkpoints each whole revision', async () => {
    const w = world([entry('1', 1), entry('2', 2), entry('3', 2)]);
    const result = await createReceiptProjector(w).drain();
    expect(result).toEqual({ kind: 'drained', checkpoint: 2, projected: 3 });
    expect(w.calls).toEqual([
      'write receipt_1', 'log receipt_1', 'checkpoint 1',
      'write receipt_2', 'log receipt_2', 'write receipt_3', 'log receipt_3', 'checkpoint 2',
    ]);
  });

  it('never checkpoints part of a revision that a full page split', async () => {
    const w = world([entry('1', 1), entry('2', 1), entry('3', 2), entry('4', 2)]);
    const result = await createReceiptProjector({ ...w, pageSize: 3 }).drain();
    expect(result).toEqual({ kind: 'drained', checkpoint: 2, projected: 4 });
    // The first page ends after receipt_3. Revision 2 is re-read whole on the next page
    // instead of being checkpointed with receipt_4 still unread.
    expect(w.calls).toEqual([
      'write receipt_1', 'log receipt_1', 'write receipt_2', 'log receipt_2', 'checkpoint 1',
      'write receipt_3', 'log receipt_3', 'write receipt_4', 'log receipt_4', 'checkpoint 2',
    ]);
  });

  it('re-drains a revision after a crash before its log line or checkpoint, without a second fact', async () => {
    const entries = [entry('1', 1), entry('2', 1)];
    for (const faults of [{ failLogAt: 'receipt_2' }, { failCheckpointAt: 1 }]) {
      const w = world(entries, faults);
      await expect(createReceiptProjector(w).drain()).rejects.toThrow('crash before');
      expect(w.checkpoint()).toBe(0);
      const logged = w.lines.length;

      // Restart against the same read model: every write compares equal and the checkpoint lands.
      expect(await createReceiptProjector(w).drain()).toEqual({ kind: 'drained', checkpoint: 1, projected: 0 });
      expect(w.facts.size).toBe(2);
      expect(w.lines.slice(logged)).toEqual(entries.map(item => receiptObservation({
        receipt: item.receipt, evidenceRef: item.evidenceRef, ledgerRevision: item.ledgerRevision,
        events: item.events.map(event => ({ channelId: event.roomId, eventId: event.eventId })),
      })));
    }
  });

  it('fails closed on a conflicting fact and leaves the checkpoint before it', async () => {
    const w = world([entry('1', 1), entry('2', 2)]);
    await createReceiptProjector(w).drain();
    const changed = world([entry('1', 1), entry('2', 2, 'ack_other'), entry('3', 3)]);
    for (const [id, json] of w.facts) changed.facts.set(id, json);
    changed.readModel.readCheckpoint = async () => 1;
    expect(await createReceiptProjector(changed).drain())
      .toEqual({ kind: 'conflict', checkpoint: 1, receiptId: 'receipt_2' });
    expect(changed.calls).toEqual(['write receipt_2']);
  });

  it('refuses an outbox row whose evidence reference disagrees with its receipt', async () => {
    const mismatched = { ...entry('1', 1), evidenceRef: 'ack_forged' };
    const w = world([mismatched]);
    expect(await createReceiptProjector(w).drain()).toEqual({ kind: 'conflict', checkpoint: 0, receiptId: 'receipt_1' });
    expect(w.calls).toEqual([]);
  });

  it('shares one run between concurrent drains', async () => {
    const w = world([entry('1', 1)]);
    const projector = createReceiptProjector(w);
    const [a, b] = await Promise.all([projector.drain(), projector.drain()]);
    expect(a).toBe(b);
    expect(w.outbox.pages).toBe(2);
    expect(w.calls.filter(call => call.startsWith('write'))).toHaveLength(1);
  });

  it('builds a closed, content-free observation', () => {
    const observation = receiptObservation({ ...entry('1', 7), events: [{ channelId: 'room_1' as RoomId, eventId: 'event_1' as EventId }] });
    expect(observation).toEqual({
      v: 1, event: RECEIPT_OBSERVATION_EVENT, receiptId: 'receipt_1', releaseId: 'release_1', bindingId: 'binding_a',
      generation: 0, kind: 'agent_acknowledged', source: 'agent', observedAt: '2026-09-25T12:00:00Z',
      evidenceRef: 'ack_7', ledgerRevision: 7, events: [{ channelId: 'room_1', eventId: 'event_1' }],
    });
  });
});
