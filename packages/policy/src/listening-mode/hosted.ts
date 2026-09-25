import type { ListeningModeControl } from '@khala/contracts/delivery/index';
import type { TrustState } from '../trust/types';
import type {
  ListeningModeStore,
  ListeningModeStoreKey,
  ListeningModeStoreRead,
  ListeningModeStoreWrite,
  ListeningModeWriteResult,
} from './store';

export type HostedTrustStateSnapshot = Readonly<{
  /** Opaque revision for the entire hosted trust aggregate. */
  revision: string;
  state: TrustState;
}>;

export type HostedTrustStateRead =
  | Readonly<{ kind: 'record'; snapshot: HostedTrustStateSnapshot }>
  | Readonly<{ kind: 'unavailable' }>;

export type HostedTrustStateCasResult =
  | Readonly<{ kind: 'applied'; revision: string }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Atomic persistence seam supplied by the host that owns TrustState. */
export interface HostedTrustStatePort {
  read(): Promise<HostedTrustStateRead>;
  compareAndSet(expectedRevision: string, state: TrustState): Promise<HostedTrustStateCasResult>;
}

function matchesKey(state: TrustState, key: ListeningModeStoreKey): boolean {
  return state.bindingId === key.bindingId && state.generation === key.generation;
}

function nextControl(current: ListeningModeControl, write: ListeningModeStoreWrite): ListeningModeControl {
  return {
    bindingId: current.bindingId,
    generation: current.generation,
    version: current.version + 1,
    ...write.next,
  };
}

/** Adapts the current TrustState aggregate without introducing a second state cell. */
export function createHostedListeningModeStore(host: HostedTrustStatePort): ListeningModeStore {
  return {
    async read(key): Promise<ListeningModeStoreRead> {
      const result = await host.read();
      if (result.kind === 'unavailable') return result;
      if (!matchesKey(result.snapshot.state, key)) return { kind: 'absent' };
      return { kind: 'record', control: result.snapshot.state.listeningMode };
    },

    async compareAndSet(write): Promise<ListeningModeWriteResult> {
      // A policy-only aggregate conflict is safe to retry. A mode-version change
      // is not: the caller must observe the competing listening-mode write.
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const result = await host.read();
        if (result.kind === 'unavailable') return result;
        const { revision, state } = result.snapshot;
        if (!matchesKey(state, write.key)) return { kind: 'conflict', current: null };

        const prior = state.listeningModeJournal.get(write.operationId);
        if (prior) {
          return prior.operationFingerprint === write.operationFingerprint
            ? prior.result
            : { kind: 'idempotency_conflict' };
        }

        const current = state.listeningMode;
        const settled = write.expectedVersion === current.version
          ? { kind: 'applied' as const, control: nextControl(current, write) }
          : { kind: 'conflict' as const, current };
        const listeningModeJournal = new Map(state.listeningModeJournal);
        listeningModeJournal.set(write.operationId, {
          operationFingerprint: write.operationFingerprint,
          result: settled,
        });
        const nextState = settled.kind === 'applied'
          ? { ...state, listeningMode: settled.control, listeningModeJournal }
          : { ...state, listeningModeJournal };
        const saved = await host.compareAndSet(revision, nextState);
        if (saved.kind === 'applied') return settled;
        if (saved.kind === 'unavailable') return saved;
      }
      return { kind: 'unavailable' };
    },
  };
}
