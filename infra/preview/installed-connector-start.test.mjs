import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingOwnerOutcome } from './installed-connector-start.mjs';

test('requires exact owner-approval candidate, not an unavailable startup', () => {
  assert.equal(pendingOwnerOutcome({ ok: true, outcome: 'pending_owner', next: 'human_approve', operationId: 'candidate_1' }), true);
  for (const result of [
    { ok: false, error: 'unavailable' },
    { ok: false, error: 'unavailable', httpStatus: 503 },
    { ok: false, error: 'invalid_link' },
    { ok: false, error: 'not_connected' },
    { ok: true, outcome: 'connecting', next: 'retry_same_link', operationId: 'candidate_1' },
    null,
  ]) assert.equal(pendingOwnerOutcome(result), false);
});
