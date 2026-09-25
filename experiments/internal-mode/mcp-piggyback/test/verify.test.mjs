import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assess } from '../verify.mjs';

const fixture = new URL('../evidence/live-run.json', import.meta.url);
const load = async () => JSON.parse(await readFile(fixture, 'utf8'));

test('retained Codex 0.154.0 evidence proves the shared format', async () => {
  assert.deepEqual(assess(await load()), { proved: true, failures: [] });
});

test('wrong implementation: receiver-side repeated-release filtering fails', async () => {
  const report = await load();
  report.cases.ordered.toolCalls[1].arguments.releaseIdsSeen = ['release-order-1'];
  const verdict = assess(report);
  assert.equal(verdict.proved, false);
  assert.match(verdict.failures.join('\n'), /state beyond the batch token/);
});

test('mentioning a release ID in model output fails the no-dedup proof', async () => {
  const report = await load();
  report.cases.ordered.model.releaseIdsSeen = ['release-order-1'];
  const verdict = assess(report);
  assert.equal(verdict.proved, false);
  assert.match(verdict.failures.join('\n'), /model output retained a release ID/);
});

test('missing exact next-call acknowledgement fails', async () => {
  const report = await load();
  report.cases.ordered.toolCalls[1].arguments.ackBatchToken = 'bt_guessed';
  const verdict = assess(report);
  assert.equal(verdict.proved, false);
  assert.match(verdict.failures.join('\n'), /did not echo exact batch token/);
});

test('raw-payload or pre-escaping byte accounting fails', async () => {
  const report = await load();
  report.cases['soft-boundary'].delivered.serializedBytes -= 1;
  const verdict = assess(report);
  assert.equal(verdict.proved, false);
  assert.match(verdict.failures.join('\n'), /exactly 128 KiB/);
});

test('non-escaping padding fails the material expansion proof', async () => {
  for (const name of ['soft-boundary', 'oversized-head']) {
    const withoutJsonExpansion = await load();
    const jsonDelivered = withoutJsonExpansion.cases[name].delivered;
    jsonDelivered.bodyBytes[0] = jsonDelivered.payloadBytes[0];
    assert.match(assess(withoutJsonExpansion).failures.join('\n'), new RegExp(`${name}: JSON escaping did not materially expand`));

    const withoutJsonRpcExpansion = await load();
    const jsonRpcDelivered = withoutJsonRpcExpansion.cases[name].delivered;
    jsonRpcDelivered.payloadBytes[0] = jsonRpcDelivered.serializedBytes;
    assert.match(assess(withoutJsonRpcExpansion).failures.join('\n'), new RegExp(`${name}: JSON-RPC escaping did not materially expand`));
  }
});

test('truncating an oversized head fails', async () => {
  const report = await load();
  report.cases['oversized-head'].model.bodyEnd = 'truncated';
  const verdict = assess(report);
  assert.equal(verdict.proved, false);
  assert.match(verdict.failures.join('\n'), /whole release/);
});
