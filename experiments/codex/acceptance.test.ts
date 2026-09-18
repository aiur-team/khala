import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSessionAcceptance, type AcceptanceInput } from './acceptance.js';

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
