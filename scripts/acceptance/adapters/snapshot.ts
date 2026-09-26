// The documented post-shutdown snapshot, read through the
// `local-sqlite-channel-store` adapter. It holds the launcher's per-user root
// lease for the whole read, so it refuses while any launcher still runs: a live
// channel store is never opened. It reads identifiers, order and receipt links
// only, never message content.

import { acquireRootLease } from '../../../apps/internal/src/launcher/lock';
import { channelDirectory } from '../../../apps/internal/src/lifecycle/paths';
import { openChannelStore } from '../../../apps/internal/src/store/open';
import type { ChannelSnapshot, SnapshotBinding, SnapshotEvent, SnapshotPort, SnapshotReceipt } from '../types';

type BindingRow = { binding_id: string; generation: number; participant_id: string; harness: string; session_id: string; status: string };
type EventRow = { sequence: number; event_id: string; author_participant_id: string; author_device_id: string; client_txn_id: string; received_at: string };
type ReceiptRow = { receipt_id: string; binding_id: string; generation: number; kind: string; source: string; observed_at: string; event_id: string | null };

export function readChannelSnapshot(internalRoot: string, channelId: string): ChannelSnapshot {
  const lease = acquireRootLease(internalRoot);
  if (lease.kind === 'held') throw new Error('a launcher still holds the internal root; the live store is never read');
  if (lease.kind === 'failed') throw new Error(`internal root unavailable: ${lease.code}`);
  try {
    const directory = channelDirectory(internalRoot, channelId);
    if (!directory) throw new Error('not a channel ID');
    const store = openChannelStore({ directory, mode: 'existing' });
    try {
      return store.read(db => {
        const bindings = (db.prepare(`
          SELECT binding_id, generation, participant_id, harness, session_id, status FROM bindings ORDER BY binding_id, generation
        `).all() as unknown as BindingRow[]).map((row): SnapshotBinding => ({
          bindingId: row.binding_id, generation: Number(row.generation), participantId: row.participant_id,
          harness: row.harness, sessionDigest: row.session_id, status: row.status === 'active' ? 'active' : 'revoked',
        }));
        const events = (db.prepare(`
          SELECT sequence, event_id, author_participant_id, author_device_id, client_txn_id, received_at
          FROM events WHERE channel_id = ? ORDER BY sequence
        `).all(channelId) as unknown as EventRow[]).map((row): SnapshotEvent => ({
          sequence: Number(row.sequence), eventId: row.event_id, authorParticipantId: row.author_participant_id,
          authorDeviceId: row.author_device_id, clientTxnId: row.client_txn_id, receivedAt: row.received_at,
        }));
        const receipts = new Map<string, SnapshotReceipt & { eventIds: string[] }>();
        const rows = db.prepare(`
          SELECT f.receipt_id, f.binding_id, f.generation, f.kind, f.source, f.observed_at, e.event_id
          FROM receipt_facts f
          LEFT JOIN receipt_fact_events e ON e.receipt_id = f.receipt_id AND e.channel_id = ?
          ORDER BY f.receipt_id, e.position
        `).all(channelId) as unknown as ReceiptRow[];
        for (const row of rows) {
          const receipt = receipts.get(row.receipt_id) ?? {
            receiptId: row.receipt_id, bindingId: row.binding_id, generation: Number(row.generation), kind: row.kind,
            source: row.source, observedAt: row.observed_at, eventIds: [],
          };
          if (row.event_id !== null) receipt.eventIds.push(row.event_id);
          receipts.set(row.receipt_id, receipt);
        }
        return { channelId, bindings, events, receipts: [...receipts.values()] };
      });
    } finally {
      store.close();
    }
  } finally {
    lease.lease.release();
  }
}

export function storeSnapshot(internalRoot: string): SnapshotPort {
  return { read: async channelId => readChannelSnapshot(internalRoot, channelId) };
}
