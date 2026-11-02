import { type Decoded, decodeWith, fail, literal, object, version } from '../messaging/decode';
import { DEFAULT_LISTENING_MODE, LISTENING_MODES, type ListeningMode } from '@khala/listener';
export { DEFAULT_LISTENING_MODE, LISTENING_MODES, type ListeningMode } from '@khala/listener';
import { readMatrixUserId } from './agent-join';

export function decodeListeningMode(input: unknown): Decoded<ListeningMode> {
  return decodeWith(() => literal(input, '', LISTENING_MODES));
}
export const LISTENING_MODE_COMMAND_TYPE = 'com.khala.listening_mode.v1' as const;
export const LISTENING_MODE_MEMBER_KEY = 'com.khala.listening_mode' as const;
/** Listener timeout choices in minutes (0 is Off): no human message for this long mutes the agent. */
export const IDLE_MUTE_CHOICES = [15, 60, 240, 1440, 0] as const;
export type IdleMuteMinutes = typeof IDLE_MUTE_CHOICES[number];
export const DEFAULT_IDLE_MUTE_MIN: IdleMuteMinutes = 60;
/** `locked` and `idleMuteMin` (each sent only when the owner changes it): the lock stops the agent changing
 * its own mode with set_mode; the listener timeout mutes it after that many minutes without a human message. */
export type ListeningModeCommandContent = Readonly<{ v: 1; agent: string; mode: ListeningMode; locked?: boolean; idleMuteMin?: IdleMuteMinutes }>;
export function decodeListeningModeCommand(input: unknown): Decoded<ListeningModeCommandContent> {
  return decodeWith(() => {
    const has = (key: string) => typeof input === 'object' && input !== null && Object.hasOwn(input, key);
    const hasLock = has('locked');
    const hasIdle = has('idleMuteMin');
    const r = object(input, '', ['v', 'agent', 'mode', ...(hasLock ? ['locked'] : []), ...(hasIdle ? ['idleMuteMin'] : [])]);
    if (hasLock && typeof r.field('locked') !== 'boolean') fail(r.at('locked'), 'wrong_type');
    if (hasIdle && !(IDLE_MUTE_CHOICES as readonly unknown[]).includes(r.field('idleMuteMin'))) fail(r.at('idleMuteMin'), 'invalid_value');
    return { v: version(r.field('v'), r.at('v')),
      agent: readMatrixUserId(r.field('agent'), r.at('agent')),
      mode: literal(r.field('mode'), r.at('mode'), LISTENING_MODES),
      ...(hasLock ? { locked: r.field('locked') as boolean } : {}),
      ...(hasIdle ? { idleMuteMin: r.field('idleMuteMin') as IdleMuteMinutes } : {}) };
  });
}
/** The owner's private room account data: their agents (Matrix user ids) whose mode they locked. */
export const MODE_LOCKS_ACCOUNT_DATA_TYPE = 'com.khala.mode_locks' as const;
/** The owner's private room account data: listener timeouts (minutes) they set away from the default, by agent Matrix user id. */
export const IDLE_MUTE_ACCOUNT_DATA_TYPE = 'com.khala.idle_mute' as const;
/** A missing mode is the default; a mode from a newer client is unknown here and reads as the quiet `async`. */
export function memberListeningMode(content: unknown): ListeningMode {
  const value = typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)[LISTENING_MODE_MEMBER_KEY] : undefined;
  if (value === undefined) return DEFAULT_LISTENING_MODE;
  const decoded = decodeListeningMode(value);
  return decoded.ok ? decoded.value : 'async';
}
