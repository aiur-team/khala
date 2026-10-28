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

export const BACKLOG_ON_LEAVE_ASYNC = ['skip', 'notice'] as const;
export const STEER_CARRIERS = ['native', 'emulated_interrupt'] as const;

/** Shared spec projections; Matrix wire records have separate evidence and decoders. */
export type ListeningModeControl = Readonly<{
  requested: ListeningMode | null;
  effective: ListeningMode | null;
  effective_reason: string | null;
  version: number;
  backlog_on_leave_async?: (typeof BACKLOG_ON_LEAVE_ASYNC)[number];
}>;
export type ListeningModeSupportEntry = Readonly<{
  status: (typeof MODE_SUPPORT_STATUSES)[number];
  reason: string | null;
}>;
export type ListeningModeSupportMap = Readonly<{
  steer: ListeningModeSupportEntry & Readonly<{ steer_carrier?: (typeof STEER_CARRIERS)[number] }>;
  sync: ListeningModeSupportEntry;
  async: ListeningModeSupportEntry;
}>;
