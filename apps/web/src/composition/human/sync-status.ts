import { useCallback, useSyncExternalStore } from 'react';
import type { OwnerId } from '@khala/contracts/messaging/index';
import type { HumanRouteContext } from './application';

/** Owner-scoped homeserver sync liveness, pushed by the Matrix client's sync events. */
export interface SyncStatusPort {
  live(ownerId: OwnerId, generation: number): boolean;
  subscribe(ownerId: OwnerId, generation: number, listener: () => void): () => void;
}

/** True while the signed-in client's sync is PREPARED or SYNCING. */
export function useLiveSync(context: HumanRouteContext): boolean {
  const port = context.syncStatus;
  const ownerId = context.principal.ownerId;
  const generation = context.generation;
  const subscribe = useCallback((listener: () => void) => port?.subscribe(ownerId, generation, listener) ?? (() => undefined),
    [port, ownerId, generation]);
  const snapshot = useCallback(() => port?.live(ownerId, generation) ?? false, [port, ownerId, generation]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
