import { createListeningModeService } from '@khala/policy/listening-mode/store';
import { type SqliteListeningModeRepository, createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import type { BindingModeOptions } from '../../server/binding-mode';
import type { AgentReleaseFeed } from '../../server/channel-server';
import type { ChannelStore } from '../../store/channel-store';
import type { InternalStoreHandle } from '../../store/open';
import { type BindingPauseStore, createBindingPauseStore } from '../../store/pause-store';
import { createInternalReleaseFeed } from '../internal-delivery/release-feed';
import { createLocalListeningModeStore } from '../local-transport/listening-mode-store';
import { createServerHarnessCapabilities } from './capabilities';

// Listening modes and pause for one internal channel store. The release feed, the
// owner's control and the agent's control all read and write the same SQLite mode
// record and the same pause record, so a change from either side takes effect on
// the next pull without any cache to invalidate.

export type BindingModesComposition = Readonly<{
  listeningModes: SqliteListeningModeRepository;
  pause: BindingPauseStore;
  /** A granted binding pulls its releases into its own inbox; nothing is pushed. A pause holds the feed before any claim. */
  releases: AgentReleaseFeed;
  /** Owner and agent mode control, plus the owner's pause. */
  control: BindingModeOptions;
}>;

export function composeBindingModes(input: Readonly<{ handle: InternalStoreHandle; store: ChannelStore }>): BindingModesComposition {
  const listeningModes = createSqliteListeningModeRepository(input.handle);
  const pause = createBindingPauseStore(input.handle);
  const harnesses = createServerHarnessCapabilities();
  return {
    listeningModes,
    pause,
    releases: createInternalReleaseFeed({ store: input.store, listeningModes, paused: binding => pause.read(binding) }),
    control: {
      modes: createListeningModeService(createLocalListeningModeStore(listeningModes)),
      pause,
      capabilities: harnesses.capabilities,
      observe: harnesses.observe,
    },
  };
}
