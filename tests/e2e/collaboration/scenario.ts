// Binds the KHA-139 collaboration acceptance case to the product decisions it needs.
// The task content and the assertions that make its result useful come only from an
// approved G-TASK decision (the P05 ruling below). Until the gates that decide what
// may run are resolved, binding returns `blocked` and no driver action is taken.

import { TASK_CHECKS } from './assertions';
import { type OwnerControls, type OwnerFixture, assertIndependentOwners, createOwnerFixture } from '../harness/owners';

/** Gates this acceptance case reads, from `docs/product/ticket-graph.proposal.json` and `docs/product/decisions.md`. */
export const GATE_IDS = ['G-TASK', 'G-HARNESSES', 'G-AUTOMATION', 'G-ADMISSION', 'G-RETENTION', 'P02'] as const;
export type GateId = (typeof GATE_IDS)[number];

/**
 * Gates that decide whether anything may run at all. The others block only the
 * assertions that name them, and those rows stay in the report as `blocked`.
 */
export const PRE_ACTION_GATES: readonly GateId[] = ['G-TASK', 'G-HARNESSES'];
/** Live acceptance cannot start while any of these operator choices is open. */
export const LIVE_PRE_ACTION_GATES: readonly GateId[] = [...PRE_ACTION_GATES, 'G-AUTOMATION', 'G-ADMISSION', 'P02'];

export type GateState =
  | Readonly<{ status: 'open'; question: string; source: string }>
  | Readonly<{ status: 'resolved'; decisionRef: string; source: string }>;

/**
 * `unresolved` while P02 is open: the case is neither required nor waived. Under the
 * P02 ruling, `required` means a message approved before the browser closed is still
 * delivered, and a new message waits for approval until the owner opens the app.
 */
export type BrowserClosedMode = 'not_required' | 'required' | 'unsupported' | 'unresolved';

export type TaskDecision = Readonly<{
  decisionRef: string;
  /** snake_case ids, each a key of `TASK_CHECKS` in `assertions.ts`. */
  assertions: readonly string[];
}>;

export type CollaborationDecisions = Readonly<{
  gates: Readonly<Record<GateId, GateState>>;
  task: TaskDecision | null;
  browserClosedMode: BrowserClosedMode;
}>;

/**
 * The P05 ruling. A's agent proposes a three-step plan to add `--version` to a toy CLI
 * in a scratch repo. B's agent replies with one critique, A posts a revised plan, and
 * B confirms it. Each owner approves delivery of every message (KHA-134). The task is
 * harness-neutral, so the same script serves every approved harness route.
 */
export const PLAN_AGREEMENT_TASK: TaskDecision = Object.freeze({
  decisionRef: 'P05 ruling: cross-owner plan agreement',
  assertions: Object.freeze(['plan_exchange_reviewed', 'revised_plan_hash_agreed', 'no_agent_admission', 'exchange_once_per_timeline']),
});

const RULINGS = 'https://github.com/aiur-team/khala/issues/48#issuecomment-5844179178';

/**
 * Historical evaluator route allowlist. Live G-HARNESSES remains open; this
 * list cannot waive a required route or establish current acceptance scope.
 */
export const APPROVED_HARNESS_ROUTES: readonly string[] = Object.freeze(['claude-code-cli-hooks', 'opencode-plugin']);
/** Route names still in final native scope; listing one is not evidence or authority to run it. */
export const CURRENT_SCOPE_HARNESSES: readonly string[] = Object.freeze(['claude-code-cli-hooks', 'opencode-plugin', 'codex']);

/**
 * Historical synthetic evaluator fixture. It preserves the old row-level
 * tests, but must never be passed to the live entry as product authority.
 */
export const HISTORICAL_FIXTURE_DECISIONS: CollaborationDecisions = {
  gates: {
    'G-TASK': {
      status: 'resolved',
      decisionRef: 'P05 Executor ruling: cross-owner plan agreement on a toy CLI --version change',
      source: 'https://github.com/aiur-team/khala/issues/48#issuecomment-5844004544',
    },
    'G-HARNESSES': {
      status: 'resolved',
      decisionRef: 'Executor ruling: only the Claude Code CLI hooks (#326/#310) and the OpenCode plugin (#323/#312); Codex excluded while #230/#266 are parked',
      source: RULINGS,
    },
    'G-AUTOMATION': {
      status: 'resolved',
      decisionRef: 'Executor ruling: hosted automation stays closed; only the local fence {3,3,1,wait} applies; a human approves every message',
      source: RULINGS,
    },
    'G-ADMISSION': {
      status: 'resolved',
      decisionRef: 'synthetic admission consent for historical evaluator fixtures only',
      source: 'test fixture, not operator authority',
    },
    'G-RETENTION': {
      status: 'resolved',
      decisionRef: 'P12 (per-link admission, default no earlier history), P13 (closure promises no deletion), P14 (no recovery, no escrow)',
      source: 'docs/product/decisions.md#P12-P14',
    },
    P02: {
      status: 'resolved',
      decisionRef: 'Executor ruling: approved messages keep flowing with no browser open; new messages wait until an owner opens the app',
      source: RULINGS,
    },
  },
  task: PLAN_AGREEMENT_TASK,
  browserClosedMode: 'required',
};

/** Current authority: preserve settled task/retention; leave unanswered choices open. */
export const CURRENT_LIVE_DECISIONS: CollaborationDecisions = {
  gates: {
    'G-TASK': HISTORICAL_FIXTURE_DECISIONS.gates['G-TASK'],
    'G-HARNESSES': { status: 'open', question: 'pin the required exact native routes and versions without a scope waiver',
      source: 'docs/product/requirements-coverage.md R07-R09' },
    'G-AUTOMATION': { status: 'open', question: 'authorize hosted unattended, trust backlog and reply budgets',
      source: 'docs/product/decisions.md P08' },
    'G-ADMISSION': { status: 'open', question: 'authorize the admission consent interaction',
      source: 'docs/product/ticket-graph.proposal.json G-ADMISSION' },
    'G-RETENTION': HISTORICAL_FIXTURE_DECISIONS.gates['G-RETENTION'],
    P02: { status: 'open', question: 'choose browser-closed delivery behavior',
      source: 'docs/product/decisions.md P02' },
  },
  task: PLAN_AGREEMENT_TASK,
  browserClosedMode: 'unresolved',
};

/** Scenario contract from the KHA-139 plan, with `unresolved` added for an open P02. */
export type CollaborationCase = Readonly<{
  caseId: string;
  taskDecisionRef: string;
  owners: readonly [OwnerFixture, OwnerFixture, OwnerFixture];
  harnessVersions: Readonly<Record<string, string>>;
  browserClosedMode: BrowserClosedMode;
  expectedTaskAssertions: readonly string[];
  /** Gates still open; assertions that name one report `blocked`. */
  openGates: readonly GateId[];
}>;

export type CaseSetup = Readonly<{
  caseId: string;
  /** Owners A and B collaborate first; C joins later with its own identity, device and session. */
  owners: Readonly<{ a: OwnerControls; b: OwnerControls; c: OwnerControls }>;
  /** Pinned harness component/version pairs; the binder's explicit scope selects valid component names. */
  harnessVersions: Readonly<Record<string, string>>;
}>;

export type BoundCase =
  | Readonly<{ kind: 'ready'; case: CollaborationCase }>
  | Readonly<{ kind: 'blocked'; caseId: string; openGates: readonly GateId[]; reasons: readonly string[] }>;

const TASK_ASSERTION = /^[a-z][a-z0-9_]{0,63}$/;

export function openGates(decisions: CollaborationDecisions): GateId[] {
  return GATE_IDS.filter(id => decisions.gates[id].status === 'open');
}

/**
 * Binds the case, or returns `blocked` naming every decision that is missing. It is
 * pure: a caller that gets `blocked` has not touched any owner, session or driver.
 */
export function bindCase(decisions: CollaborationDecisions, setup: CaseSetup,
  preActionGates: readonly GateId[] = PRE_ACTION_GATES,
  routeScope: readonly string[] = APPROVED_HARNESS_ROUTES): BoundCase {
  const open = openGates(decisions);
  const reasons: string[] = [];
  for (const id of preActionGates) {
    const gate = decisions.gates[id];
    if (gate.status === 'open') reasons.push(`${id} is open: ${gate.question} (${gate.source})`);
  }
  if (decisions.task === null) reasons.push('no approved collaboration task is recorded');
  else if (decisions.task.assertions.length === 0) reasons.push(`task ${decisions.task.decisionRef} names no success assertions`);
  if (Object.keys(setup.harnessVersions).length === 0) reasons.push('no harness version is pinned for the case');
  for (const route of Object.keys(setup.harnessVersions)) {
    if (!routeScope.includes(route)) {
      reasons.push(`harness route ${route} is not in this case's scope (${routeScope.join(', ')})`);
    }
  }
  if (decisions.gates.P02.status === 'resolved' && decisions.browserClosedMode === 'unresolved') {
    reasons.push('P02 is resolved but no browser-closed mode is recorded');
  }
  if (decisions.gates.P02.status === 'open' && decisions.browserClosedMode !== 'unresolved') {
    reasons.push('a browser-closed mode is recorded while P02 is still open');
  }
  if (reasons.length > 0 || decisions.task === null) {
    return Object.freeze({ kind: 'blocked', caseId: setup.caseId, openGates: open, reasons: Object.freeze(reasons) });
  }
  for (const id of decisions.task.assertions) {
    if (!TASK_ASSERTION.test(id)) throw new TypeError(`task assertion ${id} must match ${TASK_ASSERTION}`);
    if (!Object.hasOwn(TASK_CHECKS, id)) throw new TypeError(`task assertion ${id} has no check in TASK_CHECKS`);
  }
  const owners = [
    createOwnerFixture('a', setup.owners.a),
    createOwnerFixture('b', setup.owners.b),
    createOwnerFixture('c', setup.owners.c),
  ] as const;
  // C must not share any verified identity with A or B; channel membership grants nothing.
  assertIndependentOwners(owners);
  return Object.freeze({
    kind: 'ready',
    case: Object.freeze({
      caseId: setup.caseId,
      taskDecisionRef: decisions.task.decisionRef,
      owners,
      harnessVersions: Object.freeze({ ...setup.harnessVersions }),
      browserClosedMode: decisions.browserClosedMode,
      expectedTaskAssertions: Object.freeze([...decisions.task.assertions]),
      openGates: Object.freeze(open),
    }),
  });
}

/** The real entry uses current authority, never the scripted historical fixture. */
export function bindLiveCase(setup: CaseSetup): BoundCase {
  return bindCase(CURRENT_LIVE_DECISIONS, setup, LIVE_PRE_ACTION_GATES, CURRENT_SCOPE_HARNESSES);
}

export class CollaborationBlocked extends Error {
  constructor(readonly bound: Extract<BoundCase, { kind: 'blocked' }>) {
    super(`${bound.caseId} is blocked before any action: ${bound.reasons.join('; ')}`);
    this.name = 'CollaborationBlocked';
  }
}
