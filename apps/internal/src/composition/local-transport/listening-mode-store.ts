import type {
  ListeningModeStore, ListeningModeStoreRead, ListeningModeWriteResult,
} from '@khala/policy/listening-mode/store';
import type { SqliteListeningModeRepository } from '../../listening-mode-store/sqlite';

/** Maps the synchronous app-private repository onto the unchanged policy port. */
export function createLocalListeningModeStore(repository: SqliteListeningModeRepository): ListeningModeStore {
  return {
    async read(key): Promise<ListeningModeStoreRead> {
      return repository.read(key);
    },
    async compareAndSet(write): Promise<ListeningModeWriteResult> {
      return repository.compareAndSet(write);
    },
  };
}
