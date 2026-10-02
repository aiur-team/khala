import assert from 'node:assert/strict';
import test from 'node:test';
import { lastHostedOpenStage, pendingOwnerOutcome } from './installed-connector-start.mjs';

test('requires exact owner-approval candidate, not an unavailable startup', () => {
  assert.equal(pendingOwnerOutcome({ ok: true, outcome: 'pending_owner', next: 'human_approve', operationId: 'candidate_1' }), true);
  for (const result of [
    { ok: false, error: 'unavailable' },
    { ok: false, error: 'unavailable', httpStatus: 503 },
    { ok: false, error: 'invalid_link' },
    { ok: false, error: 'not_connected' },
    { ok: false, code: 'internal_error', kind: 'refused' },
    { ok: true, outcome: 'pending_owner', next: 'human_approve' },
    { ok: true, outcome: 'pending_owner', next: 'retry_same_link', operationId: 'candidate_1' },
    { ok: true, outcome: 'connecting', next: 'retry_same_link', operationId: 'candidate_1' },
    null,
  ]) assert.equal(pendingOwnerOutcome(result), false);
});

test('reports only a known hosted opening stage from child diagnostics', () => {
  const stderr = [
    'private token and URL',
    JSON.stringify({ component: 'hosted_open', stage: 'browser_preflight', result: 'unavailable', privatePath: '/private' }),
    JSON.stringify({ component: 'hosted_open', stage: 'secret_stage', result: 'unavailable' }),
    JSON.stringify({ component: 'other', stage: 'state_storage', result: 'unavailable' }),
    JSON.stringify({ component: 'hosted_open', stage: 'subscription_start', result: 'unavailable' }),
  ].join('\n');
  assert.equal(lastHostedOpenStage(stderr), 'subscription_start');
  assert.equal(lastHostedOpenStage('private token and URL'), undefined);
});
