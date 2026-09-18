import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseConditionFailures, sameSessionAcceptance, withConditions, type AcceptanceInput } from './acceptance.js';

const thread = '11111111-1111-4111-8111-111111111111';
const settings = { model: 'm', cwd: '/w', approvalPolicy: 'never', sandbox: { type: 'readOnly' }, reasoningEffort: 'medium' };
const ok: AcceptanceInput = {
  originalThreadId: thread, originalExecutorPid: 100, lockHolderPid: 100, observedExecutorPid: 100,
  observedThreadId: thread, clientUserMessageId: 'c', consumedMessageCount: 1,
  replyText: 'release-nonce-7 prior-marker-codex-alpha', nonce: 'release-nonce-7', priorMarker: 'prior-marker-codex-alpha',
  deliveredText: 'report release-nonce-7 with the marker you already know', settingsBefore: settings, settingsAfter: settings,
};

test('accepts same thread, same executor, one consumption, recalled prior context', () => {
  assert.deepEqual(sameSessionAcceptance(ok), { accepted: true, failures: [] });
});

test('AE2: a duplicate executor with copied history is rejected even when the reply is correct', () => {
  const r = sameSessionAcceptance({ ...ok, observedExecutorPid: 200, lockHolderPid: 100 });
  assert.equal(r.accepted, false);
  assert.deepEqual(r.failures, ['executor_process_changed']);
});

test('AE2: a new or forked thread is rejected by native thread ID, not generated text', () => {
  const r = sameSessionAcceptance({ ...ok, observedThreadId: '22222222-2222-4222-8222-222222222222' });
  assert.deepEqual(r.failures, ['thread_id_changed']);
});

test('rejects when the original executor no longer holds the writer lock', () => {
  assert.deepEqual(sameSessionAcceptance({ ...ok, lockHolderPid: null }).failures, ['writer_lock_not_held_by_original_executor']);
});

test('nonce alone does not prove context preservation', () => {
  assert.deepEqual(sameSessionAcceptance({ ...ok, replyText: 'release-nonce-7' }).failures, ['prior_context_not_reported']);
});

test('a delivery that leaks the marker cannot prove recall', () => {
  const r = sameSessionAcceptance({ ...ok, deliveredText: 'say prior-marker-codex-alpha' });
  assert.ok(r.failures.includes('marker_leaked_in_delivery'));
});

test('duplicate or missing consumption and setting drift are failures', () => {
  assert.deepEqual(sameSessionAcceptance({ ...ok, consumedMessageCount: 2 }).failures, ['consumed_more_than_once']);
  assert.ok(sameSessionAcceptance({ ...ok, consumedMessageCount: 0, replyText: null }).failures.includes('not_consumed'));
  const drift = sameSessionAcceptance({ ...ok, settingsAfter: { ...settings, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'onRequest' } });
  assert.deepEqual(drift.failures, ['setting_changed:approvalPolicy', 'setting_changed:sandbox']);
});

const busy = { kind: 'busy', statusAtDelivery: 'active', commandStartedAt: 10, commandCompletedAt: 40, commandExitCode: 0, deliveredAt: 12, consumedInBusyTurn: false } as const;

test('an idle case needs a drained queue and idle status at delivery', () => {
  assert.deepEqual(caseConditionFailures({ kind: 'idle', queueDrained: true, statusAtDelivery: 'idle' }), []);
  assert.deepEqual(caseConditionFailures({ kind: 'idle', queueDrained: false, statusAtDelivery: 'active' }),
    ['queue_not_drained_before_idle', 'not_idle_at_delivery']);
});

test('a busy case needs delivery during a completed controlled command, consumed in a later turn', () => {
  assert.deepEqual(caseConditionFailures(busy), []);
  assert.deepEqual(caseConditionFailures({ ...busy, commandStartedAt: null, commandCompletedAt: null, commandExitCode: null, statusAtDelivery: 'idle' }),
    ['not_active_at_delivery', 'controlled_command_not_started', 'controlled_command_not_completed', 'delivery_not_during_command']);
  assert.deepEqual(caseConditionFailures({ ...busy, deliveredAt: 41 }), ['delivery_not_during_command']);
  assert.deepEqual(caseConditionFailures({ ...busy, deliveredAt: 9 }), ['delivery_not_during_command']);
  assert.deepEqual(caseConditionFailures({ ...busy, consumedInBusyTurn: true }), ['consumed_in_busy_turn']);
});

test('a failed condition turns an otherwise accepted delivery into a rejection', () => {
  assert.deepEqual(withConditions(sameSessionAcceptance(ok), { ...busy, consumedInBusyTurn: true }),
    { accepted: false, failures: ['consumed_in_busy_turn'] });
});

// The committed reports predate these checks, so re-derive them from recorded facts.
function recordedConditions(file: string): Record<string, string[]> {
  const cases = JSON.parse(readFileSync(new URL(`./evidence/${file}`, import.meta.url), 'utf8')).cases;
  const busyOf = (c: any, deliveredAt: number | null, statusAtDelivery?: string) => caseConditionFailures({
    kind: 'busy', statusAtDelivery, commandStartedAt: c.busy.commandStartedAt, commandCompletedAt: c.busy.commandCompletedAt,
    commandExitCode: c.busy.exitCode, deliveredAt, consumedInBusyTurn: c.consumption.turnId === c.busy.busyTurnId });
  return {
    idle: caseConditionFailures({ kind: 'idle', queueDrained: (cases.drainBeforeIdle?.queueAtLoad ?? 1) === 0 || cases.drainBeforeIdle?.queueDrained === true,
      statusAtDelivery: cases.idle.statusAtDelivery }),
    busy: busyOf(cases.busy, cases.busy.delivery.ack, cases.busy.statusAtDelivery),
    disconnect: busyOf(cases.disconnect, cases.disconnect.writeFlushedAt),
  };
}

test('the clean run bff6ff3b meets every case condition', () => {
  assert.deepEqual(recordedConditions('live-run.json'), { idle: [], busy: [], disconnect: [] });
});

test('the drain run is correctly excluded as idle evidence', () => {
  const r = recordedConditions('live-run-drain.json');
  assert.deepEqual(r.idle, ['queue_not_drained_before_idle', 'not_idle_at_delivery']);
  assert.deepEqual([r.busy, r.disconnect], [[], []]);
});

test('run d2eaf702 accepts every case with the executor sampled at consumption', () => {
  const report = JSON.parse(readFileSync(new URL('./evidence/live-run-v2.json', import.meta.url), 'utf8'));
  assert.deepEqual(recordedConditions('live-run-v2.json'), { idle: [], busy: [], disconnect: [] });
  for (const name of ['idle', 'busy', 'disconnect']) {
    const c = report.cases[name];
    assert.deepEqual(c.acceptance, { accepted: true, failures: [] }, name);
    assert.equal(c.consumption.executorPidAtConsumption, report.executor.lockHolderAfterLoad, name);
    assert.equal(c.consumption.lockHolderAtConsumption, report.executor.lockHolderAfterLoad, name);
  }
  assert.equal(report.cases.duplicateExecutor.acceptanceIfDuplicateConsumed.accepted, false);
});

test('run 9a28af84 (guarded driver, no replay) accepts every case and exit leaves no writer', () => {
  const report = JSON.parse(readFileSync(new URL('./evidence/live-run-v3.json', import.meta.url), 'utf8'));
  assert.deepEqual(recordedConditions('live-run-v3.json'), { idle: [], busy: [], disconnect: [] });
  for (const name of ['idle', 'busy', 'disconnect']) {
    const c = report.cases[name];
    assert.deepEqual(c.acceptance, { accepted: true, failures: [] }, name);
    assert.equal(c.consumption.executorPidAtConsumption, report.executor.lockHolderAfterLoad, name);
    assert.equal(c.consumption.lockHolderAtConsumption, report.executor.lockHolderAfterLoad, name);
    assert.equal(c.consumption.consumedCount, 1, name);
  }
  assert.equal(report.executor.preLoadStatus, 'notLoaded', 'the driver hosted a dormant thread; it did not attach to a running one');
  assert.deepEqual([report.cases.disconnect.reconcile.replayProbe, report.cases.disconnect.reconcile.sameIdEntriesAfterReplay], [false, 1]);
  assert.equal(report.cases.duplicateExecutor.resumeSucceeded, false);
  assert.equal(report.cases.exit.lockHolderAfterAttempts, null);
  assert.equal(report.cases.exit.replacementProcesses, 0);
});

test('reports written before the acceptance fix are annotated as stale', () => {
  for (const file of ['live-run.json', 'live-run-drain.json']) {
    const report = JSON.parse(readFileSync(new URL(`./evidence/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(report.annotation.staleFields, ['cases.idle.acceptance', 'cases.busy.acceptance', 'cases.disconnect.acceptance'], file);
  }
});
