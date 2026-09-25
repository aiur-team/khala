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

for (const [name, routeField, value] of [
  ['transport', 'transport', 'embedded_server_http'],
  ['client', 'client', 'external_companion'],
  ['server', 'server', 'tui_embedded'],
  ['external-client', 'externalClient', true],
]) {
  test(`rejects an in-process route with a spoofed ${name} field`, async () => {
    const record = await load('in-process-plugin.json');
    record.route[routeField] = value;
    assert.throws(() => verifyRoute(record), /in-process plugin client/);
  });
}

test('rejects a route that requires Khala to launch a server', async () => {
  const record = await load('khala-launched-server.json');
  assert.throws(() => verifyRoute(record), /Khala must not launch an OpenCode server/);
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
