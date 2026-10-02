// The listening-mode wire constants the browser needs.
// TODO(#947): replace with `@khala/contracts/m1/listening-mode` once it merges.

import { LISTENING_MODES, type ListeningMode } from '@khala/contracts/delivery/listening-mode';

/** The owner's encrypted command to one of their agents. */
export const LISTENING_MODE_COMMAND_TYPE = 'com.khala.listening_mode.v1' as const;
/** The key an agent adds to its own `m.room.member` content. */
export const LISTENING_MODE_MEMBER_KEY = 'com.khala.listening_mode' as const;
export const DEFAULT_LISTENING_MODE: ListeningMode = 'sync';

/** The mode an agent's member content reports, or `sync` when it reports none. */
export function memberListeningMode(content: unknown): ListeningMode {
  if (!content || typeof content !== 'object') return DEFAULT_LISTENING_MODE;
  const value = (content as Record<string, unknown>)[LISTENING_MODE_MEMBER_KEY];
  return LISTENING_MODES.find(mode => mode === value) ?? DEFAULT_LISTENING_MODE;
}
