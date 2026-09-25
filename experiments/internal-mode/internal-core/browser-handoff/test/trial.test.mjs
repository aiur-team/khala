// Runs the real trial pipeline (fake loopback server, /proc observer, spawned
// opener → browser chain) with stand-in opener and browser processes and a
// same-user observer, so it needs neither Docker nor a browser. Cross-user
// visibility is proven by the live runner; this proves the detection logic.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runTrial } from '../lib/trial.mjs';
import { SELECTED, trialFailures } from '../verify.mjs';

const skip = process.platform !== 'linux' && 'procfs observer is Linux-only';
const fakeOpener = fileURLToPath(new URL('./fixtures/fake-opener.mjs', import.meta.url));

async function trial(strategy) {
  const parent = await mkdtemp(join(tmpdir(), 'khala-bh-test-'));
  try {
    return await runTrial({
      strategy,
      opener: { command: process.execPath, args: [fakeOpener], env: { PATH: process.env.PATH } },
      observer: { kind: 'local' },
      handoffParent: parent,
      openerPattern: 'fake-opener',
      browserPattern: 'fake-browser',
      probePrivatePaths: false,
      timeoutMs: 10_000,
      settleMs: 300,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const leakingLayers = t => new Set(t.observer.hits
  .filter(h => h.field === 'cmdline')
  .map(h => t.observer.processes.find(p => p.pid === h.pid)?.layer));

test('wrong implementation: canary URL passed as opener argv is detected and fails', { skip }, async () => {
  const result = await trial('argv-url');
  assert.equal(result.delivered, true);
  assert.equal(result.leak, true);
  assert.deepEqual([...leakingLayers(result)].sort(), ['browser', 'opener']);
  for (const hit of result.observer.hits) assert.doesNotMatch(hit.sample, /khalacanary/);
  // Judged as the selected handoff, the same trial must not pass.
  assert.match(trialFailures({ ...result, strategy: SELECTED }).join('\n'), /credential observable/);
  // As the negative control it proves the observer can see the leak.
  assert.deepEqual(trialFailures(result), []);
});

test('private-file handoff delivers the credential with no argv leak in any layer', { skip }, async () => {
  const result = await trial('private-file');
  assert.equal(result.delivered, true);
  assert.equal(result.leak, false);
  assert.deepEqual(result.observer.hits, []);
  for (const layer of ['launcher', 'opener', 'browser']) {
    assert.ok(result.observer.layers[layer] >= 1, `${layer} layer observed`);
  }
  assert.match(result.openerArgv.at(-1), /handoff-[^/]+\/open\.html$/);
});
