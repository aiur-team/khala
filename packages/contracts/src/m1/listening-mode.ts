import { type Decoded, decodeWith, fail, literal, object, version } from '../messaging/decode';
import { DEFAULT_LISTENING_MODE, LISTENING_MODES, type ListeningMode } from '@khala/listener';
export { DEFAULT_LISTENING_MODE, LISTENING_MODES, type ListeningMode } from '@khala/listener';
import { readMatrixUserId } from './agent-join';

export function decodeListeningMode(input: unknown): Decoded<ListeningMode> {
  return decodeWith(() => literal(input, '', LISTENING_MODES));
}
export const LISTENING_MODE_COMMAND_TYPE = 'com.khala.listening_mode.v1' as const;
export const LISTENING_MODE_MEMBER_KEY = 'com.khala.listening_mode' as const;
/** `locked` (sent only when the owner toggles it) stops the agent changing its own mode with set_mode. */
export type ListeningModeCommandContent = Readonly<{ v: 1; agent: string; mode: ListeningMode; locked?: boolean }>;
export function decodeListeningModeCommand(input: unknown): Decoded<ListeningModeCommandContent> {
  return decodeWith(() => {
    const hasLock = typeof input === 'object' && input !== null && Object.hasOwn(input, 'locked');
    const r = object(input, '', hasLock ? ['v', 'agent', 'mode', 'locked'] : ['v', 'agent', 'mode']);
    if (hasLock && typeof r.field('locked') !== 'boolean') fail(r.at('locked'), 'wrong_type');
    return { v: version(r.field('v'), r.at('v')),
      agent: readMatrixUserId(r.field('agent'), r.at('agent')),
      mode: literal(r.field('mode'), r.at('mode'), LISTENING_MODES),
      ...(hasLock ? { locked: r.field('locked') as boolean } : {}) };
  });
}
/** The owner's private room account data: their agents (Matrix user ids) whose mode they locked. */
export const MODE_LOCKS_ACCOUNT_DATA_TYPE = 'com.khala.mode_locks' as const;
/** A missing mode is the default; a mode from a newer client is unknown here and reads as the quiet `async`. */
export function memberListeningMode(content: unknown): ListeningMode {
  const value = typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)[LISTENING_MODE_MEMBER_KEY] : undefined;
  if (value === undefined) return DEFAULT_LISTENING_MODE;
  const decoded = decodeListeningMode(value);
  return decoded.ok ? decoded.value : 'async';
}
