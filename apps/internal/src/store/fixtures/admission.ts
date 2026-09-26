import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { InternalStoreHandle } from '../open';

/**
 * Records the admission of an already registered binding to `channelId` with the owner's
 * history shared, the row `activate` writes for `history: 'shared'`: the binding reads the
 * whole channel. Without an admission record every event read of the binding is denied.
 */
export function admitWithSharedHistory(handle: InternalStoreHandle, binding: SessionBinding, channelId: string): void {
  handle.transaction(db => {
    db.prepare(`
      INSERT INTO discovery_activations (operation_key, binding_id, generation, channel_id, session_generation, start_sequence)
      VALUES (?, ?, ?, ?, 1, 0)
    `).run(`admission-${binding.bindingId}-${binding.generation}`, binding.bindingId, binding.generation, channelId);
  });
}
