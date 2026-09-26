// The owner's listening-mode and pause control for the agents bound to one local
// channel. The local server owns the durable mode record and the pause; this port
// only reads them and submits the owner's changes. `support` and `effective` are
// the server's projection through the released claim for each agent's harness, so
// a mode the harness has not proven is never presented as usable.

import { type ListeningModeLastChangedBy, readListeningModeActor } from '@khala/contracts/delivery/index';

export const LISTENING_MODE_NAMES = ['steer', 'sync', 'async'] as const;
export type ListeningModeName = (typeof LISTENING_MODE_NAMES)[number];

/** One mode's support and the exact evidence an experimental grant pins: route, tested version and evidence revision. */
export type ModeSupportView = Readonly<{
  status: string;
  reason: string | null;
  route: string | null;
  testedVersion: string | null;
  evidenceRef: string | null;
  evidenceRevision: string | null;
}>;

/** An owner's experimental-route grant, as the server's record holds it. */
export type ExperimentalGrantView = Readonly<{
  mode: ListeningModeName;
  route: string;
  harnessVersion: string;
  evidenceRevision: string;
}>;

export type ListeningBinding = Readonly<{
  bindingId: string;
  generation: number;
  harness: string;
  /** The harness version the agent last reported, or `null` before any report. */
  harnessVersion: string | null;
  /** Whether the signed-in human owns this binding, so the last change can say "you". */
  ownedByViewer: boolean;
  displayName: string;
  /** `null` when the harness has no evidenced mode to request. */
  requested: ListeningModeName | null;
  effective: ListeningModeName | null;
  effectiveReason: string | null;
  version: number;
  /** Who made the change that produced `version`; `unknown` for records written before actors were stored. */
  lastChangedBy: ListeningModeLastChangedBy;
  paused: boolean;
  support: Readonly<Record<ListeningModeName, ModeSupportView>>;
  /** The owner's experimental-route grants on this binding generation; a stale one no longer matches `support`. */
  experimentalGrants: readonly ExperimentalGrantView[];
  /** Whether an idle agent is proven to receive a message before its next turn (decisions 34 and 37). */
  idleDelivery: 'proven' | 'unproven';
}>;

export type ListeningFailure = 'unavailable' | 'session_ended' | 'forbidden' | 'conflict' | 'outcome_unknown';

export type ListingOutcome =
  | Readonly<{ kind: 'listed'; bindings: readonly ListeningBinding[] }>
  | Readonly<{ kind: 'failed'; reason: ListeningFailure }>;

export type ChangeOutcome = Readonly<{ kind: 'done' }> | Readonly<{ kind: 'failed'; reason: ListeningFailure }>;

/** The exact experimental route an owner grants or revokes, as they reviewed it. */
export type ExperimentalRoute = Readonly<{ mode: ListeningModeName; route: string; harnessVersion: string; evidenceRevision: string }>;

export interface ListeningPort {
  list(channelId: string): Promise<ListingOutcome>;
  /** Requests `requested` against the exact version and binding generation the owner saw. */
  setMode(channelId: string, binding: ListeningBinding, requested: ListeningModeName): Promise<ChangeOutcome>;
  /** Pauses or resumes the exact binding generation the owner saw. */
  setPaused(channelId: string, binding: ListeningBinding, paused: boolean): Promise<ChangeOutcome>;
  /** Grants or revokes one experimental route against the exact version and binding generation the owner saw. */
  changeExperimentalRoute(
    channelId: string, binding: ListeningBinding, action: 'grant' | 'revoke', route: ExperimentalRoute,
  ): Promise<ChangeOutcome>;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const modeName = (value: unknown): value is ListeningModeName =>
  typeof value === 'string' && (LISTENING_MODE_NAMES as readonly string[]).includes(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2_048;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const optionalText = (value: unknown): value is string | null | undefined => value === null || value === undefined || text(value);
const orNull = (value: string | null | undefined): string | null => value ?? null;

function decodeSupport(value: unknown): Record<ListeningModeName, ModeSupportView> | null {
  if (!plain(value)) return null;
  const support = {} as Record<ListeningModeName, ModeSupportView>;
  for (const mode of LISTENING_MODE_NAMES) {
    const entry = value[mode];
    if (!plain(entry) || !text(entry.status) || !optionalText(entry.reason) || !optionalText(entry.route)
      || !optionalText(entry.testedVersion) || !optionalText(entry.evidenceRef) || !optionalText(entry.evidenceRevision)) return null;
    support[mode] = {
      status: entry.status, reason: orNull(entry.reason), route: orNull(entry.route), testedVersion: orNull(entry.testedVersion),
      evidenceRef: orNull(entry.evidenceRef), evidenceRevision: orNull(entry.evidenceRevision),
    };
  }
  return support;
}

/** Only this binding generation's experimental-route grants; hard-cancel grants are not this panel's to show. */
function decodeGrants(value: unknown, bindingId: string, generation: number): ExperimentalGrantView[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const grants: ExperimentalGrantView[] = [];
  for (const entry of value as unknown[]) {
    if (!plain(entry) || !modeName(entry.mode) || !text(entry.route) || !text(entry.harnessVersion) || !text(entry.evidenceRevision)) return null;
    if (entry.kind !== 'experimental_route' || entry.bindingId !== bindingId || entry.generation !== generation) continue;
    grants.push({ mode: entry.mode, route: entry.route, harnessVersion: entry.harnessVersion, evidenceRevision: entry.evidenceRevision });
  }
  return grants;
}

/** The grant for `mode` that still matches its current experimental support exactly, or null. */
export function currentGrant(binding: ListeningBinding, mode: ListeningModeName): ExperimentalGrantView | null {
  const support = binding.support[mode];
  return binding.experimentalGrants.find(grant => grant.mode === mode && support.status === 'experimental'
    && grant.route === support.route && grant.harnessVersion === support.testedVersion
    && grant.evidenceRevision === support.evidenceRevision) ?? null;
}

/** The experimental route the owner may enable for `mode`, or null when there is none to grant or it is already granted. */
export function grantableRoute(binding: ListeningBinding, mode: ListeningModeName): ExperimentalRoute | null {
  const { status, route, testedVersion, evidenceRevision } = binding.support[mode];
  if (status !== 'experimental' || route === null || testedVersion === null || evidenceRevision === null) return null;
  if (currentGrant(binding, mode) !== null) return null;
  return { mode, route, harnessVersion: testedVersion, evidenceRevision };
}

function decodeActor(value: unknown): ListeningModeLastChangedBy | null {
  try {
    return value === undefined ? null : readListeningModeActor(value, 'lastChangedBy');
  } catch {
    return null;
  }
}

/** The server's `{v, bindings}` list, or null when any entry is malformed: a partial list is never shown as complete. */
export function decodeBindingList(value: unknown): ListeningBinding[] | null {
  if (!plain(value) || value.v !== 1 || !Array.isArray(value.bindings)) return null;
  const bindings: ListeningBinding[] = [];
  for (const entry of value.bindings as unknown[]) {
    if (!plain(entry) || !plain(entry.binding) || !plain(entry.view) || typeof entry.paused !== 'boolean' || !text(entry.displayName)
      || typeof entry.ownedByViewer !== 'boolean' || !(entry.harnessVersion === null || text(entry.harnessVersion))
      || (entry.idleDelivery !== 'proven' && entry.idleDelivery !== 'unproven')) return null;
    const { binding, view } = entry;
    const support = decodeSupport(view.support);
    const lastChangedBy = decodeActor(view.lastChangedBy);
    const experimentalGrants = decodeGrants(view.experimentalGrants, binding.bindingId as string, binding.generation as number);
    if (!text(binding.bindingId) || !count(binding.generation) || !text(binding.harness) || support === null || experimentalGrants === null
      || !(view.requested === null || modeName(view.requested)) || !(view.effective === null || modeName(view.effective))
      || !(view.effectiveReason === null || text(view.effectiveReason)) || !count(view.version) || lastChangedBy === null) return null;
    bindings.push({
      bindingId: binding.bindingId, generation: binding.generation, harness: binding.harness,
      harnessVersion: entry.harnessVersion as string | null, ownedByViewer: entry.ownedByViewer, displayName: entry.displayName,
      requested: view.requested, effective: view.effective, effectiveReason: view.effectiveReason as string | null,
      version: view.version, lastChangedBy, paused: entry.paused, support, experimentalGrants, idleDelivery: entry.idleDelivery,
    });
  }
  return bindings;
}

/** Whether the owner may request `mode`: only a mode the harness's released claim proves, or grants experimentally. */
export function modeOffered(binding: ListeningBinding, mode: ListeningModeName): boolean {
  const status = binding.support[mode].status;
  return status === 'proven' || status === 'experimental';
}
