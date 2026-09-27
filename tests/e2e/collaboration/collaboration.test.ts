import { describe, expect, it } from 'vitest';
import { controlsFor } from '../../conformance/subjects';
import { createEvidenceLog, type EvidenceManifest } from '../harness/evidence';
import { describeLive } from '../harness/live';
import { ConflatedOwners } from '../harness/owners';
import { type DriverHandle, type ScenarioDriver, createScenarioHarness } from '../harness/scenario';
import { TASK_CHECKS } from './assertions';
import { type AcceptanceResult, appendRun, blockedResult, evaluate, newRunId, renderRun } from './evidence';
import {
  type CaseSetup, type CollaborationCase, type CollaborationDecisions, CollaborationBlocked, GATE_IDS, type GateId,
  APPROVED_HARNESS_ROUTES, PLAN_AGREEMENT_TASK, RECORDED_DECISIONS, bindCase,
} from './scenario';

const setup: CaseSetup = {
  caseId: 'two-owners-then-third',
  owners: { a: controlsFor('a'), b: controlsFor('b'), c: controlsFor('c') },
  // The scripted driver reports itself as an approved route, so that is the version pinned.
  harnessVersions: { 'claude-code-cli-hooks': '0' },
};

// Test-only gate states around the recorded P05 task. They exercise the evaluator and are not product decisions.
function decisions(open: readonly GateId[] = []): CollaborationDecisions {
  const gates = Object.fromEntries(GATE_IDS.map(id => [id, open.includes(id)
    ? { status: 'open', question: `${id} test question`, source: 'test' }
    : { status: 'resolved', decisionRef: `${id} test decision`, source: 'test' }]));
  return {
    gates: gates as CollaborationDecisions['gates'],
    task: PLAN_AGREEMENT_TASK,
    browserClosedMode: open.includes('P02') ? 'unresolved' : 'required',
  };
}

function ready(open: readonly GateId[] = []): CollaborationCase {
  const bound = bindCase(decisions(open), setup);
  if (bound.kind !== 'ready') throw new Error(bound.reasons.join('; '));
  return bound.case;
}

type Step = readonly [kind: string, seed: 'a' | 'b' | 'c', operationId: string];

// A run in which every assertion holds, in the order a live driver would observe it.
const passing: readonly Step[] = [
  ...(['a', 'b', 'c'] as const).flatMap(seed => [
    ['setup.oauth_signed_in', seed, `op-signin-${seed}`],
    ['setup.link_joined', seed, `op-join-${seed}`],
    ['setup.session_bound', seed, `op-bind-${seed}`],
  ] as const),
  ...(['a', 'b'] as const).flatMap(seed => [
    ['admission.human_approved', seed, `op-admit-${seed}`],
    ['admission.granted', seed, `op-admit-${seed}`],
  ] as const),
  // The P05 exchange: A proposes (e1), B critiques (p2), A revises (p3), B confirms (p4).
  ['task.plan_proposed', 'a', 'release-e1'],
  ['review.pending', 'b', 'release-e1'],
  ['review.previewed', 'b', 'release-e1'],
  ['review.released', 'b', 'release-e1'],
  ['model.input', 'b', 'release-e1'],
  ['session.identity_matched', 'b', 'release-e1'],
  ['task.critique_sent', 'b', 'release-p2'],
  ['review.released', 'a', 'release-p2'],
  ['model.input', 'a', 'release-p2'],
  ['session.identity_matched', 'a', 'release-p2'],
  ['task.plan_revised', 'a', 'release-p3'],
  ['task.revised_plan_hash', 'a', 'op-planhash-3f2a9c'],
  ['task.final_plan_quote', 'a', 'op-planhash-3f2a9c'],
  ['review.previewed', 'b', 'release-p3'],
  ['review.released', 'b', 'release-p3'],
  ['model.input', 'b', 'release-p3'],
  ['session.identity_matched', 'b', 'release-p3'],
  ['task.plan_confirmed', 'b', 'release-p4'],
  ['task.final_plan_quote', 'b', 'op-planhash-3f2a9c'],
  ['review.released', 'a', 'release-p4'],
  ['model.input', 'a', 'release-p4'],
  ['session.identity_matched', 'a', 'release-p4'],
  ...(['a', 'b'] as const).flatMap(seed => (['release-e1', 'release-p2', 'release-p3', 'release-p4'] as const)
    .map(op => ['timeline.shown', seed, op] as const)),
  // B's trust is effective under the local fence, but nothing is released automatically.
  ['trust.requested', 'b', 'cmd-trust-1'],
  ['trust.effective', 'b', 'cmd-trust-1'],
  ['review.pending', 'b', 'release-e2'],
  ['review.previewed', 'b', 'release-e2'],
  ['review.released', 'b', 'release-e2'],
  ['model.input', 'b', 'release-e2'],
  ['session.identity_matched', 'b', 'release-e2'],
  ['trust.rearmed', 'b', 'cmd-rearm-1'],
  ['review.pending', 'b', 'release-e3'],
  ['review.previewed', 'b', 'release-e3'],
  ['review.released', 'b', 'release-e3'],
  ['model.input', 'b', 'release-e3'],
  ['session.identity_matched', 'b', 'release-e3'],
  ['history.admitted', 'c', 'event-c-admit'],
  ['review.pending', 'c', 'release-e4'],
  ['review.released', 'c', 'release-e4'],
  ['model.input', 'c', 'release-e4'],
  ['review.released', 'a', 'release-e5'],
  ['session.busy', 'a', 'release-e5'],
  ['delivery.queued', 'a', 'release-e5'],
  ['context.consumed', 'a', 'release-e5'],
  ['presence.offline', 'b', 'event-b-off'],
  ['relay.accepted', 'b', 'release-e6'],
  ['presence.online', 'b', 'event-b-on'],
  ['delivery.caught_up', 'b', 'release-e6'],
  ['review.previewed', 'b', 'release-e6'],
  ['review.released', 'b', 'release-e6'],
  ['context.consumed', 'b', 'release-e6'],
  // P02: e7, approved before A's browser closed, still flows. e8 waits until A reopens the app.
  ['review.released', 'a', 'release-e7'],
  ['browser.closed', 'a', 'event-a-closed'],
  ['context.consumed', 'a', 'release-e7'],
  ['review.pending', 'a', 'release-e8'],
  ['browser.opened', 'a', 'event-a-opened'],
  ['review.released', 'a', 'release-e8'],
  ['model.input', 'a', 'release-e8'],
  ['session.identity_matched', 'a', 'release-e8'],
  ['recovery.completed', 'a', 'op-recover-a'],
];

/** Drives the steps through a registered live-harness test driver, as a real driver would. */
async function liveRun(steps: readonly Step[]): Promise<EvidenceManifest> {
  let handle: DriverHandle | undefined;
  const driver: ScenarioDriver = {
    name: 'collaboration-script', mode: 'live-harness', source: { component: 'claude-code-cli-hooks', version: '0' }, faults: [],
    attach: issued => { handle = issued; }, close: async () => undefined,
  };
  const scenario = await createScenarioHarness({
    runId: 'collab-test', mode: 'live-harness', owners: (['a', 'b', 'c'] as const).map(seed => ({ seed, controls: controlsFor(seed) })),
    sources: [], drivers: [driver],
  });
  for (const [kind, seed, operationId] of steps) handle!.record(kind, { ownerId: `owner-${seed}`, operationId });
  await scenario.close();
  return scenario.manifest();
}

const taskRow = (manifest: EvidenceManifest) =>
  evaluate(manifest, ready()).assertions.find(row => row.id === 'useful_task_result')!;
const outcomes = (result: AcceptanceResult) => Object.fromEntries(result.assertions.map(row => [row.id, row.outcome]));
const without = (steps: readonly Step[], kind: string, operationId: string) =>
  steps.filter(([k, , op]) => !(k === kind && op === operationId));
function insertBefore(steps: readonly Step[], anchor: Step, step: Step): Step[] {
  const at = steps.findIndex(candidate => candidate.join() === anchor.join());
  if (at < 0) throw new Error(`no anchor ${anchor.join()}`);
  return [...steps.slice(0, at), step, ...steps.slice(at)];
}
const move = (steps: readonly Step[], step: Step, anchor: Step) =>
  insertBefore(steps.filter(candidate => candidate.join() !== step.join()), anchor, step);

describe('collaboration case binding', () => {
  it('binds the P05 plan-agreement task under the decisions recorded today', () => {
    const bound = bindCase(RECORDED_DECISIONS, setup);
    expect(bound).toMatchObject({
      kind: 'ready',
      case: { expectedTaskAssertions: PLAN_AGREEMENT_TASK.assertions, browserClosedMode: 'required', openGates: [] },
    });
    for (const route of APPROVED_HARNESS_ROUTES) {
      expect(bindCase(RECORDED_DECISIONS, { ...setup, harnessVersions: { [route]: '1' } }).kind).toBe('ready');
    }
  });

  it('is blocked before any action with no pinned route or an unapproved one', () => {
    const unpinned = bindCase(RECORDED_DECISIONS, { ...setup, harnessVersions: {} });
    expect(unpinned).toMatchObject({ kind: 'blocked', reasons: ['no harness version is pinned for the case'] });
    const codex = bindCase(RECORDED_DECISIONS, { ...setup, harnessVersions: { ...setup.harnessVersions, codex: '1' } });
    expect(codex.kind).toBe('blocked');
    if (codex.kind !== 'blocked') return;
    expect(codex.reasons.join('\n')).toMatch(/harness route codex is not approved by G-HARNESSES/);
    expect(() => { throw new CollaborationBlocked(codex); }).toThrow(/blocked before any action/);
  });

  it('refuses a browser-closed mode that P02 has not decided', () => {
    const recorded = { ...decisions(['P02']), browserClosedMode: 'required' as const };
    expect(bindCase(recorded, setup)).toMatchObject({ kind: 'blocked' });
    expect(bindCase({ ...decisions(), browserClosedMode: 'unresolved' }, setup)).toMatchObject({ kind: 'blocked' });
  });

  it('refuses a task assertion with no check', () => {
    const unknown = { ...decisions(), task: { decisionRef: 'test', assertions: ['summary_agreed'] } };
    expect(() => bindCase(unknown, setup)).toThrow(/no check in TASK_CHECKS/);
  });

  it('refuses a third owner that shares an identity with B', () => {
    const shared = { ...setup, owners: { ...setup.owners, c: { ...controlsFor('c'), sessionId: controlsFor('b').sessionId } } };
    expect(() => bindCase(decisions(), shared)).toThrow(ConflatedOwners);
  });
});

describe('collaboration acceptance evaluation', () => {
  it('passes every row only when the live evidence satisfies every assertion', async () => {
    const result = evaluate(await liveRun(passing), ready());
    expect(result.assertions.filter(row => row.outcome !== 'pass')).toEqual([]);
    expect(result.outcome).toBe('pass');
    expect(result.timings.map(timing => [timing.ownerId, timing.from, timing.to])).toContainEqual(['owner-a', 'delivery.queued', 'context.consumed']);
    expect(result.timings.every(timing => timing.ms >= 0 && timing.clockId.endsWith(timing.ownerId.slice(-1)))).toBe(true);
  });

  it('fails when a pending message reaches the model before the owner releases it', async () => {
    const steps = insertBefore(without(passing, 'model.input', 'release-e1'),
      ['review.released', 'b', 'release-e1'], ['model.input', 'b', 'release-e1']);
    const result = evaluate(await liveRun(steps), ready());
    expect(outcomes(result).exact_review_release).toBe('fail');
    expect(result.outcome).toBe('fail');
  });

  it('does not count a relay acceptance as consumption for an offline participant', async () => {
    const result = evaluate(await liveRun(without(passing, 'context.consumed', 'release-e6')), ready());
    expect(outcomes(result).offline_not_consumed).toBe('fail');
    expect(result.assertions.find(row => row.id === 'offline_not_consumed')?.detail).toMatch(/never consumed/);
  });

  it('does not let the third owner inherit B\'s trust from channel membership', async () => {
    const steps = [...passing, ['trust.auto_released', 'c', 'release-e8'] as const, ['model.input', 'c', 'release-e8'] as const];
    expect(outcomes(evaluate(await liveRun(steps), ready())).third_owner_independent).toBe('fail');
  });

  it('fails ordinary onboarding when a human configures the connector', async () => {
    const steps = [...passing, ['setup.human_configured', 'a', 'op-config-a'] as const];
    expect(outcomes(evaluate(await liveRun(steps), ready())).ordinary_onboarding).toBe('fail');
  });

  it('keeps rows behind open gates blocked instead of passing the run', async () => {
    const result = evaluate(await liveRun(passing), ready(['G-AUTOMATION', 'P02']));
    expect(outcomes(result)).toMatchObject({
      trusted_delivery: 'blocked', rearm_waits: 'blocked', busy_notified_then_consumed: 'blocked', browser_closed: 'blocked',
      exact_review_release: 'pass', offline_not_consumed: 'pass',
    });
    expect(result.outcome).toBe('blocked');
    expect(result.limitations.join('\n')).toMatch(/P02 open/);
  });

  it('does not credit an automatic release, even under effective trust', async () => {
    const auto: Step[] = [['trust.auto_released', 'b', 'release-e0'], ['model.input', 'b', 'release-e0'], ['session.identity_matched', 'b', 'release-e0']];
    const afterTrust = insertBefore(passing, ['trust.rearmed', 'b', 'cmd-rearm-1'], auto[0]!);
    const result = evaluate(await liveRun(afterTrust), ready());
    expect(outcomes(result).trusted_delivery).toBe('fail');
    const consumed = evaluate(await liveRun([...auto, ...passing]), ready());
    expect(outcomes(consumed)).toMatchObject({ exact_review_release: 'fail', no_unreleased_consumption: 'fail', trusted_delivery: 'fail' });
    expect(consumed.outcome).toBe('fail');
  });

  it('accepts a refused trust request and fails an unanswered one', async () => {
    const refused = without(passing, 'trust.effective', 'cmd-trust-1');
    const answered = insertBefore(refused, ['review.pending', 'b', 'release-e2'], ['trust.refused', 'b', 'cmd-trust-1']);
    expect(outcomes(evaluate(await liveRun(answered), ready())).trusted_delivery).toBe('pass');
    expect(outcomes(evaluate(await liveRun(refused), ready())).trusted_delivery).toBe('fail');
  });

  it('requires approved messages to flow and new ones to wait while the browser is closed', async () => {
    const row = async (steps: readonly Step[]) =>
      evaluate(await liveRun(steps), ready()).assertions.find(candidate => candidate.id === 'browser_closed')!;
    expect(await row(without(passing, 'context.consumed', 'release-e7'))).toMatchObject({ outcome: 'fail', detail: expect.stringMatching(/approved earlier/) });
    const approvedWhileClosed = insertBefore(without(passing, 'review.released', 'release-e8'),
      ['browser.opened', 'a', 'event-a-opened'], ['review.released', 'a', 'release-e8']);
    expect(await row(approvedWhileClosed)).toMatchObject({ outcome: 'fail', detail: expect.stringMatching(/approved while owner-a's browser was closed/) });
    expect((await row(without(passing, 'review.pending', 'release-e8'))).detail).toMatch(/no new message arrived/);
    expect((await row(without(passing, 'browser.opened', 'event-a-opened'))).detail).toMatch(/never opened the app/);
  });

  it('does not credit an auto-release after the owner re-armed review', async () => {
    const steps = [...passing, ['trust.auto_released', 'b', 'release-e9'] as const, ['context.consumed', 'b', 'release-e9'] as const];
    expect(outcomes(evaluate(await liveRun(steps), ready()))).toMatchObject({ rearm_waits: 'fail', no_unreleased_consumption: 'fail' });
  });

  it('gates context consumption, not only model input', async () => {
    const steps = [...passing, ['context.consumed', 'c', 'release-e9'] as const];
    expect(outcomes(evaluate(await liveRun(steps), ready()))).toMatchObject({ third_owner_independent: 'fail', no_unreleased_consumption: 'fail' });
  });

  it('checks every offline episode and busy delivery, not just the first', async () => {
    const offline = [...passing, ['presence.offline', 'c', 'event-c-off'] as const, ['relay.accepted', 'c', 'release-e10'] as const,
      ['presence.online', 'c', 'event-c-on'] as const];
    expect(outcomes(evaluate(await liveRun(offline), ready())).offline_not_consumed).toBe('fail');
    const busy = [...passing, ['session.busy', 'b', 'release-e11'] as const, ['delivery.queued', 'b', 'release-e11'] as const];
    expect(outcomes(evaluate(await liveRun(busy), ready())).busy_notified_then_consumed).toBe('fail');
  });

  it('refuses consumption credited without catch-up after reconnect', async () => {
    const result = evaluate(await liveRun(without(passing, 'delivery.caught_up', 'release-e6')), ready());
    expect(outcomes(result).offline_not_consumed).toBe('fail');
  });

  it('fails the task when a final quote differs from the revised plan hash', async () => {
    const steps = without(passing, 'task.final_plan_quote', 'op-planhash-3f2a9c')
      .concat([['task.final_plan_quote', 'a', 'op-planhash-3f2a9c'], ['task.final_plan_quote', 'b', 'op-planhash-0bad00']]);
    expect(taskRow(await liveRun(steps))).toMatchObject({ outcome: 'fail', detail: expect.stringMatching(/revised_plan_hash_agreed: owner-b quoted/) });
  });

  it('fails the task when a critique reaches A without A approving delivery', async () => {
    const steps = without(passing, 'review.released', 'release-p2');
    expect(taskRow(await liveRun(steps)).detail).toMatch(/plan_exchange_reviewed: owner-a did not approve delivery/);
  });

  it('fails the task when an agent approves an admission', async () => {
    const steps = [...passing, ['admission.agent_approved', 'a', 'op-admit-b2'] as const];
    expect(taskRow(await liveRun(steps)).detail).toMatch(/no_agent_admission: an agent approved/);
  });

  it('fails the task when a message shows twice in a timeline', async () => {
    const steps = [...passing, ['timeline.shown', 'b', 'release-p3'] as const];
    expect(taskRow(await liveRun(steps)).detail).toMatch(/exchange_once_per_timeline: task.plan_revised shows 2 times in owner-b/);
  });

  it('fails the task when an admission has no prior human approval', async () => {
    const unapproved = without(passing, 'admission.human_approved', 'op-admit-a');
    expect(taskRow(await liveRun(unapproved)).detail).toMatch(/no_agent_admission: admission.granted\/op-admit-a was granted without a prior human approval/);
    const late = [...unapproved, ['admission.human_approved', 'a', 'op-admit-a'] as const];
    expect(taskRow(await liveRun(late)).detail).toMatch(/no_agent_admission: admission.granted\/op-admit-a was granted without/);
    const ungranted = without(passing, 'admission.granted', 'op-admit-b');
    expect(taskRow(await liveRun(ungranted)).detail).toMatch(/no_agent_admission: owner-b's agent has no recorded admission/);
  });

  it('fails the task when the exchange runs out of order', async () => {
    const early = move(passing, ['task.plan_revised', 'a', 'release-p3'], ['model.input', 'a', 'release-p2']);
    expect(taskRow(await liveRun(early)).detail)
      .toMatch(/plan_exchange_reviewed: owner-a sent task.plan_revised before its model consumed the message it answers/);
    const confirmedFirst = move(passing, ['task.plan_confirmed', 'b', 'release-p4'], ['task.plan_proposed', 'a', 'release-e1']);
    expect(taskRow(await liveRun(confirmedFirst)).detail).toMatch(/plan_exchange_reviewed: owner-b sent task.plan_confirmed before/);
  });

  it('fails the task when A sends the critique', async () => {
    const steps = passing.map(step => step[0] === 'task.critique_sent' ? ['task.critique_sent', 'a', step[2]] as const : step);
    expect(taskRow(await liveRun(steps)).detail).toMatch(/plan_exchange_reviewed: task.critique_sent\/release-p2 was sent by owner-a, not owner-b/);
  });

  it('fails the task when the revised plan is sent twice', async () => {
    const steps = [...passing, ['task.plan_revised', 'a', 'release-p3b'] as const];
    expect(taskRow(await liveRun(steps)).detail).toMatch(/plan_exchange_reviewed: expected one task.plan_revised, found 2/);
  });

  it('fails every exchange-based check on its own when the exchange is malformed', async () => {
    const { records } = await liveRun([...passing, ['task.plan_revised', 'a', 'release-p3b'] as const]);
    for (const id of ['plan_exchange_reviewed', 'revised_plan_hash_agreed', 'exchange_once_per_timeline']) {
      expect(TASK_CHECKS[id]!(records, ready())).toEqual({ passed: false, reason: 'expected one task.plan_revised, found 2' });
    }
  });

  it('fails the task when a released message never reaches the recipient model', async () => {
    const steps = without(passing, 'model.input', 'release-p3');
    expect(taskRow(await liveRun(steps)).detail).toMatch(/plan_exchange_reviewed: task.plan_revised never reached owner-b's model/);
    const inputFirst = move(passing, ['model.input', 'b', 'release-p3'], ['review.released', 'b', 'release-p3']);
    expect(taskRow(await liveRun(inputFirst)).detail).toMatch(/plan_exchange_reviewed: task.plan_revised never reached owner-b's model/);
  });

  it('fails the task when a plan quote precedes the owner\'s final message', async () => {
    const steps = move(passing, ['task.final_plan_quote', 'b', 'op-planhash-3f2a9c'], ['task.plan_confirmed', 'b', 'release-p4']);
    expect(taskRow(await liveRun(steps)).detail)
      .toMatch(/revised_plan_hash_agreed: task.final_plan_quote\/op-planhash-3f2a9c precedes owner-b's final message/);
    const twice = [...passing, ['task.final_plan_quote', 'a', 'op-planhash-3f2a9c'] as const];
    expect(taskRow(await liveRun(twice)).detail).toMatch(/revised_plan_hash_agreed: expected one task.final_plan_quote from owner-a, found 2/);
  });

  it('fails the task unless A records one revised plan hash after its revised plan', async () => {
    const twice = [...passing, ['task.revised_plan_hash', 'a', 'op-planhash-3f2a9c'] as const];
    expect(taskRow(await liveRun(twice)).detail).toMatch(/revised_plan_hash_agreed: expected one task.revised_plan_hash, found 2/);
    const byB = passing.map(step => step[0] === 'task.revised_plan_hash' ? ['task.revised_plan_hash', 'b', step[2]] as const : step);
    expect(taskRow(await liveRun(byB)).detail).toMatch(/revised_plan_hash_agreed: task.revised_plan_hash\/op-planhash-3f2a9c was recorded by owner-b, not owner-a/);
    const untied = move(passing, ['task.revised_plan_hash', 'a', 'op-planhash-3f2a9c'], ['task.plan_revised', 'a', 'release-p3']);
    expect(taskRow(await liveRun(untied)).detail).toMatch(/revised_plan_hash_agreed: .* is not tied to owner-a's task.plan_revised\/release-p3/);
  });

  it('refuses evidence from a harness version the case was not bound to', async () => {
    const bound = bindCase(decisions(), { ...setup, harnessVersions: { 'claude-code-cli-hooks': '1' } });
    if (bound.kind !== 'ready') throw new Error('expected ready');
    const result = evaluate(await liveRun(passing), bound.case);
    expect(result.outcome).toBe('fail');
    expect(result.assertions.every(row => /claude-code-cli-hooks 1 was not observed/.test(row.detail))).toBe(true);
    expect(bindCase(decisions(), { ...setup, harnessVersions: {} })).toMatchObject({ kind: 'blocked' });
  });

  it('refuses fake-contract evidence', () => {
    const fake = createEvidenceLog({ runId: 'collab-fake', mode: 'fake-contract', sources: [] }).manifest();
    const result = evaluate(fake, ready());
    expect(result.outcome).toBe('fail');
    expect(result.assertions.every(row => /fake-contract evidence cannot prove/.test(row.detail))).toBe(true);
  });
});

describe('collaboration evidence report', () => {
  it('appends blocked runs under distinct run ids and never overwrites one', () => {
    const bound = bindCase(RECORDED_DECISIONS, { ...setup, harnessVersions: {} });
    if (bound.kind !== 'blocked') throw new Error('expected blocked');
    const first = blockedResult(newRunId(new Date('2026-09-25T00:00:00Z')), bound);
    const second = blockedResult(newRunId(new Date('2026-09-25T00:00:00Z')), bound);
    expect(first.runId).not.toBe(second.runId);
    expect(first.assertions.every(row => row.outcome === 'blocked')).toBe(true);
    const context = { sourceSha: 'abc1234', mode: 'none', date: '2026-09-25' };
    const report = appendRun(appendRun('# Report', first, renderRun(first, context)), second, renderRun(second, context));
    expect(report.match(/### Run /g)).toHaveLength(2);
    expect(() => appendRun(report, first, renderRun(first, context))).toThrow(/already reported/);
  });
});

describeLive('collaboration acceptance (KHA-139)', liveCase => {
  liveCase('two owners collaborate, then an independent third owner joins', async () => {
    // Every gate is decided, but no live route version is pinned until a live driver exists.
    // The acceptance tickets (#134, #241) pin an approved route and reuse this harness-neutral task.
    const bound = bindCase(RECORDED_DECISIONS, { ...setup, harnessVersions: {} });
    // Blocked is a failed live run, never a skip: the report keeps the blocked row.
    if (bound.kind === 'blocked') throw new CollaborationBlocked(bound);
    throw new Error('no live collaboration driver is registered for the approved task');
  });
});
