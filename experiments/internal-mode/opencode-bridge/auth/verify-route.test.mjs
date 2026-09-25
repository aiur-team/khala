import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyRoute } from './verify-route.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function load(name) {
  return JSON.parse(await readFile(join(fixtures, name), 'utf8'));
}

test('admits an in-process plugin route', async () => {
  const record = await load('in-process-plugin.json');
  assert.equal(verifyRoute(record), record);
});

test('rejects an authenticated external embedded-server route', async () => {
  const record = await load('authenticated-external.json');
  assert.throws(() => verifyRoute(record), /in-process plugin client/);
});

test('rejects an unauthenticated external embedded-server route', async () => {
  const record = await load('unauthenticated-external.json');
  assert.throws(() => verifyRoute(record), /in-process plugin client/);
});

test('rejects an unauthenticated external route even when every call returned 200', async () => {
  const record = await load('unauthenticated-external-all-200.json');
  assert.ok(record.sessionCalls.every(({ status }) => status === 200));
  assert.throws(() => verifyRoute(record), /in-process plugin client/);
});
