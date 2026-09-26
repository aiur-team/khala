// Cursor app capability record, scoped to exact proof tuples. A mode is proven only
// for the full shape/version/account-tier/policy tuple a retained trial covered; any
// other tuple, including one with an uninspectable field, reports `unknown`.

import {
  type AppHarnessIdentity, type AppHarnessRecord, type DeliveryLimits, type ListeningMode, type ModeSupport,
  LISTENING_MODES, decodeAppHarnessRecord, sameAppHarnessIdentity,
} from '@khala/contracts/delivery/index';

export const CURSOR_HARNESS = 'cursor';
export const CURSOR_ADAPTER_VERSION = 'cursor-app-1';
/** The verifier output every proof tuple below must match. */
export const CURSOR_PROOF_MATRIX_REF = 'experiments/interactive-cli/cursor-app/evidence/matrix.json';

/** The Cursor app shapes the proof kit grades. Other app shapes are not Cursor's. */
export const CURSOR_SHAPES = ['local_chat', 'cloud_task'] as const;
export type CursorShape = (typeof CURSOR_SHAPES)[number];

/** Route names as the proof matrix records them. */
export const CURSOR_MODE_ROUTES: Readonly<Record<ListeningMode, string>> = Object.freeze({
  steer: 'cursor.postToolUse',
  sync: 'cursor.stop',
  async: 'mcp.khala_read',
});

const BOUNDARIES = { steer: 'postToolUse', sync: 'stop', async: 'khala_read' } as const;

export type CursorRouteProof = Readonly<{
  identity: AppHarnessIdentity;
  mode: ListeningMode;
  evidenceRef: string;
  evidenceRevision: string;
}>;

/**
 * Proven Cursor cells. Empty: the 2026-09-25 proof (#243) kept every cell Blocked
 * because no Cursor install or account existed to key a trial. A cell is added here
 * only together with the `matrix.json` entry that proves it.
 */
export const CURSOR_ROUTE_PROOFS: readonly CursorRouteProof[] = Object.freeze([]);

/** Why each shape is Blocked, verbatim from the proof record. */
export const CURSOR_BLOCKED_REASONS: Readonly<Record<CursorShape, string>> = Object.freeze({
  local_chat: 'Blocked on 2026-09-25: Cursor is not installed on the proof host and no Cursor account is signed in (host-inventory.txt), so no exact Cursor version, account tier, or administrator policy exists to key a trial. A person must run kit/ in their own Agent Chat; no hook timing, model-context, restart, or acknowledgement evidence exists.',
  cloud_task: 'Blocked on 2026-09-25: no Cursor account and no existing cloud agent is available (host-inventory.txt). Creating a cloud agent to test would not be the person\'s existing session. Cursor documents no sessionStart hook for cloud agents and no user-level hooks there, so a trial needs project hooks committed into that agent\'s repository.',
});

/** The short form each unknown mode carries; the full reason stays in the proof record. */
export const CURSOR_BLOCKED_SUMMARIES: Readonly<Record<CursorShape, string>> = Object.freeze({
  local_chat: 'Blocked: the 2026-09-25 Cursor proof had no Cursor install or account, so no Agent Chat trial exists.',
  cloud_task: 'Blocked: the 2026-09-25 Cursor proof had no Cursor account or existing cloud agent, so no cloud trial exists.',
});

export const CURSOR_NEXT_TURN_ONLY_REASON =
  'Idle agents receive messages only at their next turn until a Cursor idle route is proven.';

/**
 * What was inspected about the running Cursor app. `null` means the fact could not be
 * observed; it never matches a proof, so the cell stays `unknown`.
 */
export type CursorInspection = Readonly<{
  shape: CursorShape;
  appVersion: string | null;
  accountTier: string | null;
  administratorPolicyScope: string | null;
}>;

const UNKNOWN = 'unknown';
const INSPECTED_FIELDS = ['appVersion', 'accountTier', 'administratorPolicyScope'] as const;

/** A proof is credited only for its exact tuple: shape, version, tier and policy all equal. */
function proofCovers(proof: CursorRouteProof, identity: AppHarnessIdentity): boolean {
  return sameAppHarnessIdentity(proof.identity, identity);
}

function assertProof(proof: CursorRouteProof): void {
  const { identity } = proof;
  const exact = identity.app === CURSOR_HARNESS
    && (CURSOR_SHAPES as readonly string[]).includes(identity.shape)
    && INSPECTED_FIELDS.every(field => identity[field].length > 0 && identity[field] !== UNKNOWN);
  if (!exact || proof.evidenceRef.length === 0 || proof.evidenceRevision.length === 0) {
    throw new Error('cursor capabilities: a proof must name an exact Cursor tuple and its evidence');
  }
}

function unknownMode(mode: ListeningMode, inspection: CursorInspection, version: string): ModeSupport {
  const missing = INSPECTED_FIELDS.filter(field => inspection[field] === null);
  const scope = missing.length > 0
    ? `Cursor ${missing.join(', ')} could not be inspected, so no proof can match this session.`
    : 'No retained Cursor proof matches this exact version, account tier and policy.';
  const idle = mode === 'async' ? '' : ` ${CURSOR_NEXT_TURN_ONLY_REASON}`;
  return {
    status: 'unknown',
    route: CURSOR_MODE_ROUTES[mode],
    testedVersion: version,
    evidenceRef: null,
    evidenceRevision: null,
    reason: `${scope} ${CURSOR_BLOCKED_SUMMARIES[inspection.shape]}${idle}`,
  };
}

/**
 * The app capability record for one inspected Cursor session. `support` is
 * `unsupported` because Khala never pushes into Cursor: a proven mode is delivered by
 * the person's own hook or `khala_read` pulling the shared inbox batch.
 */
export function cursorAppRecord(
  inspection: CursorInspection,
  limits: DeliveryLimits,
  proofs: readonly CursorRouteProof[] = CURSOR_ROUTE_PROOFS,
): AppHarnessRecord {
  for (const proof of proofs) assertProof(proof);
  const identity: AppHarnessIdentity = {
    v: 1,
    app: CURSOR_HARNESS,
    shape: inspection.shape,
    appVersion: inspection.appVersion ?? UNKNOWN,
    accountTier: inspection.accountTier ?? UNKNOWN,
    administratorPolicyScope: inspection.administratorPolicyScope ?? UNKNOWN,
  };
  const inspected = INSPECTED_FIELDS.every(field => inspection[field] !== null);
  const proofFor = (mode: ListeningMode) => (inspected
    ? proofs.find(proof => proof.mode === mode && proofCovers(proof, identity))
    : undefined);

  const modes = {} as Record<ListeningMode, ModeSupport>;
  const boundaries = {} as { -readonly [M in ListeningMode]: (typeof BOUNDARIES)[M] | null };
  for (const mode of LISTENING_MODES) {
    const proof = proofFor(mode);
    modes[mode] = proof === undefined
      ? unknownMode(mode, inspection, identity.appVersion)
      : {
        status: 'proven',
        route: CURSOR_MODE_ROUTES[mode],
        testedVersion: identity.appVersion,
        evidenceRef: proof.evidenceRef,
        evidenceRevision: proof.evidenceRevision,
        reason: null,
      };
    // Only a proven route names the boundary it uses; a candidate is never selectable.
    (boundaries as Record<ListeningMode, string | null>)[mode] = proof === undefined ? null : BOUNDARIES[mode];
  }
  const proven = LISTENING_MODES.filter(mode => modes[mode].status === 'proven');
  const hookProven = proven.some(mode => mode !== 'async');

  const record = decodeAppHarnessRecord({
    ...identity,
    boundaries,
    capabilities: {
      v: 3,
      harness: CURSOR_HARNESS,
      version: identity.appVersion,
      adapterVersion: CURSOR_ADAPTER_VERSION,
      support: 'unsupported',
      existingSession: hookProven ? 'native_hooks' : 'unknown',
      immediateNotification: 'unknown',
      busy: 'unknown',
      // The connector's own refusal is the only receipt this adapter emits.
      receiptEvidence: ['failed'],
      reconcileByReleaseId: 'unknown',
      limits,
      evidenceRef: proven.length > 0 ? CURSOR_PROOF_MATRIX_REF : null,
      modes,
      // Every proven cell includes acknowledgement on a later agent call.
      acknowledgement: proven.length > 0 ? 'batch_token_next_call' : 'unknown',
    },
  });
  if (record.ok) return record.value;
  // A value the contract cannot carry is reported as uninspected, not echoed.
  if (INSPECTED_FIELDS.some(field => inspection[field] !== null)) {
    return cursorAppRecord({ shape: inspection.shape, appVersion: null, accountTier: null, administratorPolicyScope: null }, limits, proofs);
  }
  throw new Error(`cursor capabilities: invalid ${record.field}`);
}
