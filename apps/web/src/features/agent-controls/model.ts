import type {
  BindingId, HarnessCapabilities, ListeningMode, ModeSupport, OwnerId, PolicyAckErrorCode, RouteGrant,
} from '@khala/contracts/delivery/index';
import { LISTENING_MODES, initialListeningMode } from '@khala/contracts/delivery/index';
import type { AgentControlsSnapshot, ListeningModeSnapshot } from './ports';

export type PolicyMode = 'review' | 'auto';

/**
 * `'effective'` is reserved for this exact command's own terminal ack from
 * the connector — never for a values-only snapshot coincidence, which is
 * `'matches'` instead (a request that could have been satisfied by anyone,
 * not proof this command produced it).
 */
export type PolicyAcknowledgment = 'pending' | 'effective' | 'matches' | 'offline' | 'rejected' | 'unknown';

/**
 * Requested and effective state are tracked independently: an ack echoing the
 * browser's own most recent command is not guaranteed when concurrent commands
 * exist, so `requestedMode`/`requestedVersion`/`requestedPaused` are local
 * intent, never derived from `effectiveMode`/`effectiveVersion`/`paused`.
 * `effectiveVersion === null` means no authoritative snapshot has been
 * observed yet, never that policy is version 0. A failed or stale request
 * keeps its requested fields (never coerced to `null`) so the human can see
 * what was asked for and retry with the same identity (AE2); `errorCode`
 * carries the closed failure vocabulary rather than being dropped.
 */
export type PolicyDisplay = Readonly<{
  effectiveMode: PolicyMode | null;
  effectiveVersion: number | null;
  paused: boolean | null;
  requestedMode: PolicyMode | null;
  requestedVersion: number | null;
  requestedPaused: boolean | null;
  acknowledgment: PolicyAcknowledgment;
  errorCode: PolicyAckErrorCode | null;
}>;

export type ConnectionState = 'connected' | 'offline' | 'unknown';

/** A transient, dismiss-by-refresh notice about something the human should act on. */
export type AgentControlsNotice = Readonly<{
  kind: 'binding-replaced' | 'request-failed' | 'snapshot-error';
  message: string;
}>;

/**
 * Local display projection over KHA-106 `PolicySetCommand`/`PolicyAck`/
 * `DeliveryReceipt`, not a replacement for those canonical contracts.
 * `controlsAvailable` is `true` only when the binding is active, viewer-owned,
 * and the approved policy and the adapter's inspected `HarnessCapabilities`
 * both permit at least one control (KTD3) — it is never simulated for a
 * capability that was not observed.
 */
export type AgentControlsView = Readonly<{
  bindingId: BindingId;
  ownerLabel: string;
  agentLabel: string;
  roomLabel: string;
  isViewerOwned: boolean;
  revoked: boolean;
  policy: PolicyDisplay;
  connection: ConnectionState;
  controlsAvailable: boolean;
  unavailableReason: string | null;
  /** The exact inspected harness support/existing-session states, shown honestly regardless of whether they gate the controls. */
  capabilityDetail: string | null;
  /** True only after a genuinely unknown-outcome (network) failure; drives a distinct "Retry" affordance from the general "Refresh" recovery action. */
  retryAvailable: boolean;
  notice: AgentControlsNotice | null;
  receiptDetail: string | null;
  /** Listening-mode section; `null` until the store has answered for this binding generation. */
  listening: ListeningDisplay | null;
}>;

export const INITIAL_POLICY_DISPLAY: PolicyDisplay = {
  effectiveMode: null,
  effectiveVersion: null,
  paused: null,
  requestedMode: null,
  requestedVersion: null,
  requestedPaused: null,
  acknowledgment: 'pending',
  errorCode: null,
};

/**
 * "Your agent" / "Another person's agent" is derived from `ownerId` compared
 * against the viewer's own, never from a caller-supplied free string — a
 * sibling feature (`timeline/attribution.ts`) does the equivalent for the
 * message list, but cross-feature imports are disallowed here (see
 * `scripts/check-boundaries.mjs`), so the comparison is reimplemented locally.
 * The owner suffix disambiguates two different owners who might otherwise
 * render identically in this single-binding panel; a longer slice than a bare
 * `#last4` is used since owner ids are opaque strings, not guaranteed to vary
 * only in their last few characters.
 */
export function ownerLabelFor(bindingOwnerId: OwnerId, viewerOwnerId: OwnerId): string {
  if (bindingOwnerId === viewerOwnerId) return 'Your agent';
  return `Another person's agent (#${bindingOwnerId.slice(-8)})`;
}

export function initialAgentControlsView(input: Readonly<{
  bindingId: BindingId;
  agentLabel: string;
  roomLabel: string;
}>): AgentControlsView {
  return {
    bindingId: input.bindingId,
    ownerLabel: 'Unknown owner',
    agentLabel: input.agentLabel,
    roomLabel: input.roomLabel,
    isViewerOwned: false,
    revoked: false,
    policy: INITIAL_POLICY_DISPLAY,
    connection: 'unknown',
    controlsAvailable: false,
    unavailableReason: 'Waiting for an authoritative snapshot.',
    capabilityDetail: null,
    retryAvailable: false,
    notice: null,
    receiptDetail: null,
    listening: null,
  };
}

// ---------------------------------------------------------------------------
// Listening mode (docs/product/internal-mode/listening-modes.md, "Honest UI")
// ---------------------------------------------------------------------------

export type ListeningEffectiveLabel = ListeningMode | 'waiting' | 'none';
export type RouteGrantKind = RouteGrant['kind'];

/**
 * Maps identifier-like evidence references to internal paths. Only an entry in
 * this allowlist becomes a link; every other reference is plain text.
 */
export type EvidenceRegistry = Readonly<Record<string, string>>;

export type EvidenceDetail = Readonly<{
  route: string;
  testedVersion: string | null;
  evidenceRef: string | null;
  /** Set only when `evidenceRef` resolves through the allowlisted registry. */
  evidenceHref: string | null;
  evidenceRevision: string | null;
}>;

/**
 * State of one owner grant against the current exact-route support.
 * `expired` names what changed; a stale grant is never reused automatically.
 */
export type GrantState =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'granted'; grant: RouteGrant }>
  | Readonly<{ kind: 'expired'; grant: RouteGrant; changes: readonly string[] }>;

export type ListeningModeOption = Readonly<{
  mode: ListeningMode;
  status: ModeSupport['status'];
  /** True only for an active, viewer-owned session whose exact route is usable now. */
  selectable: boolean;
  description: string;
  evidence: EvidenceDetail;
  experimentalGrant: GrantState;
  /** An experimental route the owner may opt into (or re-confirm after expiry). */
  canGrantExperimental: boolean;
}>;

export type HardCancelDisplay = Readonly<{
  status: ModeSupport['status'];
  description: string;
  evidence: EvidenceDetail;
  grant: GrantState;
  canGrant: boolean;
}>;

export type ListeningSubmission =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending'; attempted: ListeningMode }>
  | Readonly<{ kind: 'applied'; attempted: ListeningMode }>
  | Readonly<{ kind: 'conflict'; attempted: ListeningMode }>
  | Readonly<{ kind: 'refused'; attempted: ListeningMode; reason: string }>
  | Readonly<{ kind: 'unknown'; attempted: ListeningMode }>;

export type GrantConfirmation = Readonly<{
  grantKind: RouteGrantKind;
  mode: ListeningMode;
  sessionLabel: string;
  evidence: EvidenceDetail;
  /** The proof Khala does not yet have for this route. */
  missingProof: string;
  warning: string;
  /** Present when this confirmation replaces an expired grant. */
  expiredChanges: readonly string[] | null;
}>;

export type ListeningDisplay = Readonly<{
  generation: number;
  version: number;
  sessionLabel: string;
  sessionActive: boolean;
  /** Why no mode or grant action is possible right now, or `null`. */
  inactiveReason: string | null;
  /** `null` when the harness has no proven or experimental mode to request. */
  requested: ListeningMode | null;
  effective: ListeningEffectiveLabel;
  effectiveReason: string | null;
  initialReason: string | null;
  lastChangeLabel: string;
  idleClaim: string | null;
  secondaryEvidence: string | null;
  deliveryIssue: string | null;
  options: readonly ListeningModeOption[];
  hardCancel: HardCancelDisplay;
  /** The owner's chosen but unsubmitted mode; kept across a conflict for explicit retry. */
  draft: ListeningMode | null;
  submission: ListeningSubmission;
  confirmation: GrantConfirmation | null;
  /** Result of the last grant or revoke, shown until the next action. */
  grantNotice: string | null;
  /** Increments whenever focus must move back to the refreshed selector. */
  focusToken: number;
}>;

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

/** 64-bit digest from two independent 32-bit FNV-1a passes, as 16 hex characters. */
function bindingDigest(bindingId: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < bindingId.length; index += 1) {
    const code = bindingId.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * A readable identifier derived from the immutable binding ID. It starts at
 * four characters and widens until no other visible active binding shares it;
 * if even the full digest collides, the full binding ID is used.
 */
export function bindingShortId(bindingId: BindingId, siblings: readonly BindingId[]): string {
  const own = bindingDigest(bindingId);
  const others = siblings.filter(id => id !== bindingId).map(bindingDigest);
  for (let length = 4; length <= own.length; length += 1) {
    const prefix = own.slice(0, length);
    if (!others.some(other => other.startsWith(prefix))) return prefix;
  }
  return bindingId;
}

/** `<CLI name> <version> · <binding-short-id>`, repeated on every listening surface. */
export function sessionLabelFor(snapshot: AgentControlsSnapshot, siblings: readonly BindingId[]): string {
  return agentLabelFor(snapshot.binding.harness, snapshot.capabilities?.version ?? null, snapshot.binding.bindingId, siblings);
}

/** The same label from its parts, for surfaces that hold no full snapshot. */
export function agentLabelFor(harness: string, version: string | null, bindingId: BindingId, siblings: readonly BindingId[]): string {
  const name = HARNESS_NAMES[harness] ?? harness;
  return `${name} ${version ?? 'version unknown'} · ${bindingShortId(bindingId, siblings)}`;
}

const IDENTIFIER_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolves an evidence reference only through the allowlisted registry, and
 * only to a same-origin path. URL-shaped or unregistered references stay text.
 */
export function evidenceHrefFor(ref: string | null, registry: EvidenceRegistry): string | null {
  if (ref === null || !IDENTIFIER_REF.test(ref)) return null;
  if (!Object.hasOwn(registry, ref)) return null;
  const target = registry[ref];
  if (target === undefined || !target.startsWith('/') || target.startsWith('//') || target.includes(':')) return null;
  return target;
}

function evidenceOf(support: ModeSupport, registry: EvidenceRegistry): EvidenceDetail {
  return {
    route: support.route,
    testedVersion: support.testedVersion ?? null,
    evidenceRef: support.evidenceRef,
    evidenceHref: evidenceHrefFor(support.evidenceRef, registry),
    evidenceRevision: support.evidenceRevision,
  };
}

/** Exact binding, generation, route, version and evidence revision; grant revision is not identity. */
function grantMatchesSupport(grant: RouteGrant, binding: Readonly<{ bindingId: BindingId; generation: number }>, support: ModeSupport): boolean {
  if (support.status !== 'proven' && support.status !== 'experimental') return false;
  return grant.bindingId === binding.bindingId
    && grant.generation === binding.generation
    && grant.route === support.route
    && grant.harnessVersion === support.testedVersion
    && grant.evidenceRevision === support.evidenceRevision;
}

function grantChanges(grant: RouteGrant, support: ModeSupport): string[] {
  const changes: string[] = [];
  if (support.status !== 'proven' && support.status !== 'experimental') {
    changes.push(`support is now ${support.status.replaceAll('_', ' ')}`);
  }
  if (grant.route !== support.route) changes.push(`route changed from ${grant.route} to ${support.route}`);
  const version = support.testedVersion ?? 'unknown';
  if (grant.harnessVersion !== version) changes.push(`harness version changed from ${grant.harnessVersion} to ${version}`);
  const revision = support.evidenceRevision ?? 'none';
  if (grant.evidenceRevision !== revision) {
    changes.push(`evidence revision changed from ${grant.evidenceRevision} to ${revision}`);
  }
  return changes;
}

export function grantStateFor(
  grants: readonly RouteGrant[],
  kind: RouteGrantKind,
  mode: ListeningMode,
  binding: Readonly<{ bindingId: BindingId; generation: number }>,
  support: ModeSupport,
): GrantState {
  const candidates = grants.filter(grant => grant.kind === kind
    && grant.mode === mode
    && grant.bindingId === binding.bindingId
    && grant.generation === binding.generation);
  const live = candidates.find(grant => grantMatchesSupport(grant, binding, support));
  if (live) return { kind: 'granted', grant: live };
  const stale = candidates.at(-1);
  if (stale) return { kind: 'expired', grant: stale, changes: grantChanges(stale, support) };
  return { kind: 'none' };
}

const MISSING_PROOF = 'Khala has not proved the composed delivery route on this version.';
const BLOCKED_WITHOUT_WRAPPER = 'Native delivery unavailable; wrapper-based support is awaiting product-operator approval.';

function supportDescription(support: ModeSupport, grant: GrantState, harnessName: string): string {
  switch (support.status) {
    case 'proven':
      return `Supported on ${harnessName} ${support.testedVersion} via ${support.route}`;
    case 'experimental': {
      const proof = `Missing proof: ${support.reason ?? MISSING_PROOF}`;
      if (grant.kind === 'granted') return `Experimental on ${harnessName} ${support.testedVersion} via ${support.route}; enabled by your grant. ${proof}`;
      if (grant.kind === 'expired') return `Experimental consent expired: ${grant.changes.join('; ')}. Review the updated evidence to confirm again.`;
      return `Experimental on ${harnessName} ${support.testedVersion} via ${support.route}; disabled until you enable the experimental route. ${proof}`;
    }
    case 'blocked_without_wrapper':
      return BLOCKED_WITHOUT_WRAPPER;
    case 'unsupported':
      return `Unsupported: ${support.reason}`;
    case 'unknown':
      return `Support unknown for this version/session: ${support.reason}`;
  }
}

const EFFECTIVE_REASONS: Readonly<Record<string, string>> = {
  capabilities_unavailable: 'Current harness capabilities are unavailable.',
  no_requested_mode: 'No listening mode is requested: this harness has no proven or experimental mode.',
  support_experimental: 'The requested route is experimental and has no current grant.',
  support_unsupported: 'The requested route is unsupported on this version/session.',
  support_unknown: 'Support for the requested route is unknown on this version/session.',
  support_blocked_without_wrapper: BLOCKED_WITHOUT_WRAPPER,
  acknowledgement_unavailable: 'This route cannot acknowledge a pulled batch on the next call.',
  experimental_grant_required: 'The requested route is experimental and needs a current owner grant.',
};

const ACK_UNAVAILABLE = 'Acknowledgement unavailable: this route cannot acknowledge a pulled batch on the next call.';

function inactiveReasonFor(snapshot: AgentControlsSnapshot, viewerOwnerId: OwnerId): string | null {
  if (snapshot.bindingStatus === 'revoked') {
    return 'No active interactive session: this binding was stopped. Resume or rejoin the CLI to change its listening mode.';
  }
  if (snapshot.connection !== 'connected' || snapshot.capabilities === null) {
    return 'No active interactive session. Resume or rejoin the CLI to change its listening mode.';
  }
  if (snapshot.binding.ownerId !== viewerOwnerId) return "This binding belongs to another person's agent connection.";
  return null;
}

/** Who made the current version's change; `lastChange` covers records written before actors were stored. */
export function lastChangeLabelFor(
  listening: Readonly<{
    view: Pick<ListeningModeSnapshot['view'], 'version' | 'lastChangedBy'>;
    lastChange: ListeningModeSnapshot['lastChange'];
  }>,
  isViewerOwned: boolean,
  sessionLabel: string,
): string {
  const version = listening.view.version;
  const recorded = listening.view.lastChangedBy;
  const actor = recorded.kind !== 'unknown'
    ? recorded.kind
    : listening.lastChange?.version === version ? listening.lastChange.actor : null;
  if (actor === null) return `Last change: not recorded for v${version}`;
  const who = actor === 'agent'
    ? `the agent (${sessionLabel})`
    : isViewerOwned ? 'you (owner)' : 'the owner';
  return `Last changed by ${who} (v${version})`;
}

function secondaryEvidenceFor(capabilities: HarnessCapabilities | null): string | null {
  if (capabilities === null || capabilities.evidenceRef === null) return null;
  return `Secondary hosted evidence ${capabilities.evidenceRef} (existing session: ${capabilities.existingSession}) `
    + 'is shown for context only and cannot enable a listening mode.';
}

export type ListeningProjection = Omit<
  ListeningDisplay, 'draft' | 'submission' | 'confirmation' | 'grantNotice' | 'focusToken'
>;

/**
 * Projects one authoritative snapshot into the listening section. Only the
 * exact binding's primary `support` map can make a mode selectable; a stopped
 * or disconnected session keeps its label and requested mode, shows effective
 * `none`, and exposes no action.
 */
export function projectListening(
  snapshot: AgentControlsSnapshot,
  viewerOwnerId: OwnerId,
  registry: EvidenceRegistry,
): ListeningProjection | null {
  const listening = snapshot.listening;
  if (listening === null) return null;
  const { view } = listening;
  const binding = { bindingId: view.bindingId, generation: view.generation };
  const sessionLabel = sessionLabelFor(snapshot, listening.siblingBindingIds);
  const harnessName = HARNESS_NAMES[snapshot.binding.harness] ?? snapshot.binding.harness;
  const inactiveReason = inactiveReasonFor(snapshot, viewerOwnerId);
  const sessionActive = snapshot.bindingStatus === 'active' && snapshot.connection === 'connected' && snapshot.capabilities !== null;
  const actionable = inactiveReason === null;
  const acknowledgementReady = snapshot.capabilities?.acknowledgement === 'batch_token_next_call';

  const options = LISTENING_MODES.map((mode): ListeningModeOption => {
    const support = view.support[mode];
    const experimentalGrant = support.status === 'experimental' || view.experimentalGrants.some(grant => grant.mode === mode)
      ? grantStateFor(view.experimentalGrants, 'experimental_route', mode, binding, support)
      : { kind: 'none' as const };
    const usable = support.status === 'proven'
      || (support.status === 'experimental' && experimentalGrant.kind === 'granted');
    const ackBlocked = mode === 'async' && usable && !acknowledgementReady;
    const description = supportDescription(support, experimentalGrant, harnessName)
      + (ackBlocked ? ` ${ACK_UNAVAILABLE}` : '');
    return {
      mode,
      status: support.status,
      selectable: actionable && usable && !ackBlocked,
      description,
      evidence: evidenceOf(support, registry),
      experimentalGrant,
      canGrantExperimental: actionable && support.status === 'experimental' && experimentalGrant.kind !== 'granted',
    };
  });

  const hardCancelSupport: ModeSupport = listening.hardCancel ?? {
    status: 'unknown',
    route: view.support.steer.route,
    evidenceRef: null,
    evidenceRevision: null,
    reason: 'Hard-cancel support has not been inventoried for this route.',
  };
  const hardCancelGrant = grantStateFor(view.hardCancelGrants, 'hard_cancel', 'steer', binding, hardCancelSupport);
  const hardCancelUsable = hardCancelSupport.status === 'proven' || hardCancelSupport.status === 'experimental';
  const hardCancel: HardCancelDisplay = {
    status: hardCancelSupport.status,
    description: hardCancelUsable
      ? `Hard cancel ${hardCancelSupport.status} on ${harnessName} ${hardCancelSupport.testedVersion} via ${hardCancelSupport.route}.`
        + (hardCancelGrant.kind === 'expired' ? ` Consent expired: ${hardCancelGrant.changes.join('; ')}.` : '')
      : hardCancelSupport.status === 'blocked_without_wrapper'
        ? BLOCKED_WITHOUT_WRAPPER
        : `Hard cancel ${hardCancelSupport.status}: ${hardCancelSupport.reason}`,
    evidence: evidenceOf(hardCancelSupport, registry),
    grant: hardCancelGrant,
    canGrant: actionable && hardCancelUsable && hardCancelGrant.kind !== 'granted',
  };

  const initial = initialListeningMode(view.support);
  const initialReason = view.requested === 'async' && view.version === 1 && initial.requested === 'async'
    ? `Started in async because sync is unsupported on this exact interactive route: ${initial.reason}`
    : null;

  const effective: ListeningEffectiveLabel = sessionActive ? view.effective ?? 'waiting' : 'none';
  const effectiveReason = !sessionActive
    ? null
    : view.effective === null
      ? EFFECTIVE_REASONS[view.effectiveReason ?? ''] ?? view.effectiveReason ?? 'The requested route is not usable right now.'
      : null;

  const receipt = snapshot.latestReceipt;
  const deliveryIssue = receipt !== null && (receipt.kind === 'failed' || receipt.kind === 'outcome_unknown')
    ? `Delivery problem on ${sessionLabel}; the listening mode was not changed. See the delivery status below.`
    : null;

  return {
    generation: view.generation,
    version: view.version,
    sessionLabel,
    sessionActive,
    inactiveReason,
    requested: view.requested,
    effective,
    effectiveReason,
    initialReason,
    lastChangeLabel: lastChangeLabelFor(listening, snapshot.binding.ownerId === viewerOwnerId, sessionLabel),
    idleClaim: listening.idleDelivery === 'proven' ? null : 'Idle agents receive messages only at their next turn.',
    secondaryEvidence: secondaryEvidenceFor(snapshot.capabilities),
    deliveryIssue,
    options,
    hardCancel,
  };
}

const MODE_WARNINGS: Readonly<Record<RouteGrantKind, string>> = {
  experimental_route: 'Enabling this experimental route lets you select it for this binding only. '
    + 'It does not enable hard cancel.',
  hard_cancel: 'Hard cancel interrupts the agent mid-turn. A tool call already in progress may have partly '
    + 'taken effect. This grant does not change the listening mode or any experimental route.',
};

export function grantConfirmationFor(
  display: ListeningProjection,
  grantKind: RouteGrantKind,
  mode: ListeningMode,
): GrantConfirmation | null {
  if (grantKind === 'hard_cancel') {
    if (!display.hardCancel.canGrant) return null;
    return {
      grantKind,
      mode: 'steer',
      sessionLabel: display.sessionLabel,
      evidence: display.hardCancel.evidence,
      missingProof: display.hardCancel.status === 'proven' ? 'None: this route is proven.' : MISSING_PROOF,
      warning: MODE_WARNINGS.hard_cancel,
      expiredChanges: display.hardCancel.grant.kind === 'expired' ? display.hardCancel.grant.changes : null,
    };
  }
  const option = display.options.find(candidate => candidate.mode === mode);
  if (!option?.canGrantExperimental) return null;
  return {
    grantKind,
    mode,
    sessionLabel: display.sessionLabel,
    evidence: option.evidence,
    missingProof: option.description.includes('Missing proof: ')
      ? option.description.slice(option.description.indexOf('Missing proof: ') + 'Missing proof: '.length)
      : MISSING_PROOF,
    warning: MODE_WARNINGS.experimental_route,
    expiredChanges: option.experimentalGrant.kind === 'expired' ? option.experimentalGrant.changes : null,
  };
}

const SUBMISSION_TEXT = {
  pending: (mode: ListeningMode) => `Requesting ${mode}…`,
  applied: (mode: ListeningMode) => `Listening mode set to ${mode}.`,
  conflict: (mode: ListeningMode) => `Another actor changed the listening mode first. Your choice (${mode}) was not submitted; review the refreshed state and apply it again if you still want it.`,
  unknown: (mode: ListeningMode) => `Could not reach the connector; the outcome of ${mode} is unknown. Refresh before trying again.`,
} as const;

/** Text for the permanently mounted listening status region. */
export function listeningStatusText(display: ListeningDisplay): string {
  const parts = [`Requested: ${display.requested ?? 'none'} · Effective: ${display.effective}`];
  if (display.effective !== display.requested && display.effectiveReason) parts.push(display.effectiveReason);
  const submission = display.submission;
  if (submission.kind === 'refused') parts.push(`Your choice (${submission.attempted}) was refused: ${submission.reason}.`);
  else if (submission.kind !== 'idle') parts.push(SUBMISSION_TEXT[submission.kind](submission.attempted));
  if (display.grantNotice) parts.push(display.grantNotice);
  return parts.join(' ');
}
