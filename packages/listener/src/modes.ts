export const LISTENING_MODES = ['steer', 'sync', 'async'] as const;
export const MODE_SUPPORT_STATUSES = [
  'proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown',
] as const;
export type ListeningMode = (typeof LISTENING_MODES)[number];
export const DEFAULT_LISTENING_MODE: ListeningMode = 'sync';

export function decodeListeningMode(input: unknown):
  | Readonly<{ ok: true; value: ListeningMode }>
  | Readonly<{ ok: false; code: 'invalid_field'; field: '' }> {
  return LISTENING_MODES.includes(input as ListeningMode)
    ? { ok: true, value: input as ListeningMode }
    : { ok: false, code: 'invalid_field', field: '' };
}
