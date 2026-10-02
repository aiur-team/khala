import { LISTENING_MODES, decodeListeningMode, type ListeningMode } from '../delivery/listening-mode';
import { type Decoded, decodeWith, literal, object, version } from '../messaging/decode';
import { readMatrixUserId } from './agent-join';

export { LISTENING_MODES, decodeListeningMode, type ListeningMode };
export const LISTENING_MODE_COMMAND_TYPE = 'com.khala.listening_mode.v1' as const;
export const LISTENING_MODE_MEMBER_KEY = 'com.khala.listening_mode' as const;
export const DEFAULT_LISTENING_MODE: ListeningMode = 'sync';
export type ListeningModeCommandContent = Readonly<{ v: 1; agent: string; mode: ListeningMode }>;
export function decodeListeningModeCommand(input: unknown): Decoded<ListeningModeCommandContent> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'agent', 'mode']);
    return { v: version(r.field('v'), r.at('v')),
      agent: readMatrixUserId(r.field('agent'), r.at('agent')),
      mode: literal(r.field('mode'), r.at('mode'), LISTENING_MODES) };
  });
}
export function memberListeningMode(content: unknown): ListeningMode {
  const value = typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)[LISTENING_MODE_MEMBER_KEY] : undefined;
  const decoded = decodeListeningMode(value);
  return decoded.ok ? decoded.value : DEFAULT_LISTENING_MODE;
}
