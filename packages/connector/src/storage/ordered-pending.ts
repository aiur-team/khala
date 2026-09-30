import { decodeEventRef, type SessionBinding } from '@khala/contracts/delivery/index';
import { decodeUnavailableEventRef } from '@khala/contracts/messaging/index';
import { StorageError } from './errors';
import { storageInternals, type ConnectorStorage } from './open';
import { runTransaction } from './ledger';

export type OrderedPendingReference = Readonly<{ roomId: string; eventId: string; authorParticipantId: string;
  ledgerRevision: number; previouslyDelivered: boolean }>;

/** Upgrade input from the committed intake order. Never reads held payloads or sorts sender timestamps. */
export function readOrderedPendingReferences(storage: ConnectorStorage, binding: SessionBinding): readonly OrderedPendingReference[] {
  const internals = storageInternals.get(storage);
  if (!internals) throw new StorageError('closed');
  internals.assertUsable();
  return runTransaction(internals.ctx, () => {
    const rows = internals.ctx.db.prepare(`
      SELECT p.event_ref, 'pending' AS kind,
        min(p.ledger_revision, coalesce(u.ledger_revision, p.ledger_revision)) AS sequence,
        CASE WHEN d.state IN ('accepted', 'completed') THEN 1 ELSE 0 END AS delivered
      FROM pending p
      LEFT JOIN unavailable u ON u.room_id=p.room_id AND u.event_id=p.event_id
        AND u.binding_id=p.binding_id AND u.generation=p.generation
      LEFT JOIN release_items r ON r.room_id=p.room_id AND r.event_id=p.event_id
        AND r.binding_id=p.binding_id AND r.generation=p.generation
      LEFT JOIN dispatch_records d ON d.release_id=r.release_id
      WHERE p.binding_id=? AND p.generation=?
      UNION ALL
      SELECT event_ref, 'unavailable', ledger_revision, 0 FROM unavailable
      WHERE binding_id=? AND generation=? AND replaced_revision IS NULL
      ORDER BY sequence ASC
    `).all(binding.bindingId, binding.generation, binding.bindingId, binding.generation) as {
      event_ref: string; kind: 'pending' | 'unavailable'; sequence: number; delivered: number;
    }[];
    return rows.map(row => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.event_ref); } catch { throw new StorageError('corrupt'); }
      const decoded = row.kind === 'pending' ? decodeEventRef(parsed) : decodeUnavailableEventRef(parsed);
      if (!decoded.ok || !Number.isSafeInteger(row.sequence) || row.sequence < 1) throw new StorageError('corrupt');
      return { roomId: decoded.value.roomId, eventId: decoded.value.eventId,
        authorParticipantId: decoded.value.authorParticipantId, ledgerRevision: row.sequence, previouslyDelivered: row.delivered === 1 };
    });
  });
}
