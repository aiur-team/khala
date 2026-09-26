// The owner's listening-mode and pause control for the agents bound to one local
// channel. The local server owns the durable mode record and the pause; this port
// only reads them and submits the owner's changes. `support` and `effective` are
// the server's projection through the released claim for each agent's harness, so
// a mode the harness has not proven is never presented as usable.

export const LISTENING_MODE_NAMES = ['steer', 'sync', 'async'] as const;
export type ListeningModeName = (typeof LISTENING_MODE_NAMES)[number];

export type ModeSupportView = Readonly<{ status: string; reason: string | null }>;

export type ListeningBinding = Readonly<{
  bindingId: string;
  generation: number;
  harness: string;
  displayName: string;
  /** `null` when the harness has no evidenced mode to request. */
  requested: ListeningModeName | null;
  effective: ListeningModeName | null;
  effectiveReason: string | null;
  version: number;
  paused: boolean;
  support: Readonly<Record<ListeningModeName, ModeSupportView>>;
  /** Whether an idle agent is proven to receive a message before its next turn (decisions 34 and 37). */
  idleDelivery: 'proven' | 'unproven';
}>;

export type ListeningFailure = 'unavailable' | 'session_ended' | 'forbidden' | 'conflict' | 'outcome_unknown';

export type ListingOutcome =
  | Readonly<{ kind: 'listed'; bindings: readonly ListeningBinding[] }>
  | Readonly<{ kind: 'failed'; reason: ListeningFailure }>;

export type ChangeOutcome = Readonly<{ kind: 'done' }> | Readonly<{ kind: 'failed'; reason: ListeningFailure }>;

export interface ListeningPort {
  list(channelId: string): Promise<ListingOutcome>;
  /** Requests `requested` against the exact version and binding generation the owner saw. */
  setMode(channelId: string, binding: ListeningBinding, requested: ListeningModeName): Promise<ChangeOutcome>;
  /** Pauses or resumes the exact binding generation the owner saw. */
  setPaused(channelId: string, binding: ListeningBinding, paused: boolean): Promise<ChangeOutcome>;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const modeName = (value: unknown): value is ListeningModeName =>
  typeof value === 'string' && (LISTENING_MODE_NAMES as readonly string[]).includes(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2_048;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function decodeSupport(value: unknown): Record<ListeningModeName, ModeSupportView> | null {
  if (!plain(value)) return null;
  const support = {} as Record<ListeningModeName, ModeSupportView>;
  for (const mode of LISTENING_MODE_NAMES) {
    const entry = value[mode];
    if (!plain(entry) || !text(entry.status) || !(entry.reason === null || entry.reason === undefined || text(entry.reason))) return null;
    support[mode] = { status: entry.status, reason: typeof entry.reason === 'string' ? entry.reason : null };
  }
  return support;
}

/** The server's `{v, bindings}` list, or null when any entry is malformed: a partial list is never shown as complete. */
export function decodeBindingList(value: unknown): ListeningBinding[] | null {
  if (!plain(value) || value.v !== 1 || !Array.isArray(value.bindings)) return null;
  const bindings: ListeningBinding[] = [];
  for (const entry of value.bindings as unknown[]) {
    if (!plain(entry) || !plain(entry.binding) || !plain(entry.view) || typeof entry.paused !== 'boolean' || !text(entry.displayName)
      || (entry.idleDelivery !== 'proven' && entry.idleDelivery !== 'unproven')) return null;
    const { binding, view } = entry;
    const support = decodeSupport(view.support);
    if (!text(binding.bindingId) || !count(binding.generation) || !text(binding.harness) || support === null
      || !(view.requested === null || modeName(view.requested)) || !(view.effective === null || modeName(view.effective))
      || !(view.effectiveReason === null || text(view.effectiveReason)) || !count(view.version)) return null;
    bindings.push({
      bindingId: binding.bindingId, generation: binding.generation, harness: binding.harness, displayName: entry.displayName,
      requested: view.requested, effective: view.effective, effectiveReason: view.effectiveReason as string | null,
      version: view.version, paused: entry.paused, support, idleDelivery: entry.idleDelivery,
    });
  }
  return bindings;
}

/** Whether the owner may request `mode`: only a mode the harness's released claim proves, or grants experimentally. */
export function modeOffered(binding: ListeningBinding, mode: ListeningModeName): boolean {
  const status = binding.support[mode].status;
  return status === 'proven' || status === 'experimental';
}
