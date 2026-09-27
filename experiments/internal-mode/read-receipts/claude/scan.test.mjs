import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDirectory, scanText } from './scan.mjs';

const clean = JSON.stringify({ scenarios: [{ label: 'busy-1', present: true, equal: true, result: 'acknowledged' }] });
const token = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9v';

test('accepts redacted presence and equality results', () => {
  assert.deepEqual(scanText('ok.json', clean), []);
});

test('wrong implementation: retained token bytes, digests and token lines fail the scan', () => {
  assert.ok(scanText('a.json', JSON.stringify({ result: token })).some(f => f.rule === 'opaque-run'));
  assert.ok(scanText('b.txt', `sha256:${'a1'.repeat(16)}`).some(f => f.rule === 'reusable-digest'));
  assert.ok(scanText('c.log', 'batchToken: redacted').some(f => f.rule === 'batch-token-line'));
  assert.ok(scanText('d.json', JSON.stringify({ tokenHash: 'x' })).some(f => f.rule === 'unexpected-key'));
  assert.ok(scanText('e.txt', 'message CANARY-7', ['CANARY-7']).some(f => f.rule === 'canary'));
});

test('findings never echo the matched bytes', () => {
  assert.equal(JSON.stringify(scanText('f.json', JSON.stringify({ result: token }))).includes(token), false);
});

test('the retained evidence in this directory is clean', async () => {
  assert.deepEqual(await scanDirectory(new URL('.', import.meta.url).pathname), []);
});
