// Durable harness route selection over the owner connector's already-open ledger.
// The newest binding generation is authoritative; a route cannot change in place.

import type { BindingId } from '@khala/contracts/delivery/index';
import { StorageError } from './errors';
import { requireCount, requireIdentifier, runTransaction } from './ledger';
import { type ConnectorStorage, storageInternals } from './open';

export type HarnessSelectionResult = 'stored' | 'matched' | 'route_changed' | 'stale_generation';

export interface HarnessSelectionStore {
  record(selection: Readonly<{
    bindingId: BindingId;
    generation: number;
    routeId: string;
  }>): Promise<HarnessSelectionResult>;
}

function context(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals) throw new StorageError('closed');
  internals.assertUsable();
  return internals.ctx;
}

/** A generation-fenced route selection store backed by the connector SQLite ledger. */
export function createHarnessSelectionStore(storage: ConnectorStorage): HarnessSelectionStore {
  return {
    async record(selection) {
      const bindingId = requireIdentifier(selection.bindingId);
      const generation = requireCount(selection.generation);
      const routeId = requireIdentifier(selection.routeId);
      const ctx = context(storage);
      return runTransaction(ctx, (): HarnessSelectionResult => {
        const current = ctx.db.prepare(`SELECT generation, route_id FROM harness_route_selections
          WHERE binding_id = ?`).get(bindingId) as { generation: number; route_id: string } | undefined;
        if (current === undefined) {
          ctx.db.prepare(`INSERT INTO harness_route_selections (binding_id, generation, route_id)
            VALUES (?, ?, ?)`).run(bindingId, generation, routeId);
          return 'stored';
        }
        if (generation < current.generation) return 'stale_generation';
        if (generation === current.generation) {
          return routeId === current.route_id ? 'matched' : 'route_changed';
        }
        ctx.db.prepare(`UPDATE harness_route_selections SET generation = ?, route_id = ?
          WHERE binding_id = ?`).run(generation, routeId, bindingId);
        return 'stored';
      });
    },
  };
}
