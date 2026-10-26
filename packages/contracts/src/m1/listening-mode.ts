import { type Decoded, decodeWith, literal, object, version } from '../messaging/decode';
import { DEFAULT_LISTENING_MODE } from '@khala/listener';
export { DEFAULT_LISTENING_MODE } from '@khala/listener';
import { readMatrixUserId } from './agent-join';

/** Highest attention first. `mute` (nothing delivered, nothing wakes) needs no delivery route, so it lives
 * here rather than in the delivery capability model. */
export const LISTENING_MODES = ['steer', 'sync', 'async', 'mute'] as const;
export type ListeningMode = (typeof LISTENING_MODES)[number];
export function decodeListeningMode(input: unknown): Decoded<ListeningMode> {
  return decodeWith(() => literal(input, '', LISTENING_MODES));
}
export const LISTENING_MODE_COMMAND_TYPE = 'com.khala.listening_mode.v1' as const;
export const LISTENING_MODE_MEMBER_KEY = 'com.khala.listening_mode' as const;
export type ListeningModeCommandContent = Readonly<{ v: 1; agent: string; mode: ListeningMode }>;
export function decodeListeningModeCommand(input: unknown): Decoded<ListeningModeCommandContent> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'agent', 'mode']);
    return { v: version(r.field('v'), r.at('v')),
      agent: readMatrixUserId(r.field('agent'), r.at('agent')),
      mode: literal(r.field('mode'), r.at('mode'), LISTENING_MODES) };
  });
}
/** A missing mode is the default; a mode from a newer client is unknown here and reads as the quiet `async`. */
export function memberListeningMode(content: unknown): ListeningMode {
  const value = typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)[LISTENING_MODE_MEMBER_KEY] : undefined;
  if (value === undefined) return DEFAULT_LISTENING_MODE;
  const decoded = decodeListeningMode(value);
  return decoded.ok ? decoded.value : 'async';
}
