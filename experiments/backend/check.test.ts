import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, proof } from './check.ts';

test('compose uses immutable isolated loopback-only services', () => validate());
test('real Synapse/Postgres: identity, history, database outage and recovery', { timeout: 300_000 }, async () => {
  const evidence = await proof();
  assert.equal(evidence.restart_identity, 'pass');
  assert.equal(evidence.restart_history, 'pass');
  assert.match(evidence.unavailable_database_write, /^http-5\d\d-rejected$/);
  assert.equal(evidence.database_recovery, 'fresh-write-and-readback-pass');
  console.log(JSON.stringify(evidence));
});
