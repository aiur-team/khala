/** Modes with a hook delivery route; each has a support entry. */
export const DELIVERY_MODES = ['steer', 'sync', 'async'] as const;
/** Highest attention first. `mute` delivers nothing and wakes nothing, so it needs no delivery route. */
export const LISTENING_MODES = [...DELIVERY_MODES, 'mute'] as const;
export const MODE_SUPPORT_STATUSES = [
  'proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown',
] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type ListeningMode = (typeof LISTENING_MODES)[number];
export const DEFAULT_LISTENING_MODE: ListeningMode = 'sync';

export function decodeListeningMode(input: unknown):
  | Readonly<{ ok: true; value: ListeningMode }>
  | Readonly<{ ok: false; code: 'invalid_field'; field: '' }> {
  return LISTENING_MODES.includes(input as ListeningMode)
    ? { ok: true, value: input as ListeningMode }
    : { ok: false, code: 'invalid_field', field: '' };
}

/** Whether a new entry wakes an idle agent, or re-opens its turn at Stop. A wake is only ever a constant,
 * content-free nudge. `addressed`: a direct ping (`@name`, `@agents`, `@channel`). Steer always wakes; sync
 * wakes unless another agent sent it unaddressed; async wakes only when addressed; mute never wakes. */
export function wakesOn(mode: ListeningMode, addressed: boolean, fromAgent: boolean): boolean {
  if (mode === 'mute') return false;
  if (mode === 'async') return addressed;
  return mode === 'steer' || addressed || !fromAgent;
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
