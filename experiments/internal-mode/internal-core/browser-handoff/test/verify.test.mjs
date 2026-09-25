import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assess, assessMatrix } from '../verify.mjs';

const matrixPath = fileURLToPath(new URL('../matrix.json', import.meta.url));
const load = async name => JSON.parse(await readFile(new URL(`../evidence/${name}`, import.meta.url), 'utf8'));
const EVIDENCE = ['linux-xdg-open-generic-chromium.json', 'linux-xdg-open-generic-firefox.json'];
const selected = e => e.trials.find(t => t.strategy === 'private-file');
const control = e => e.trials.find(t => t.strategy === 'argv-url');

test('retained cross-user evidence proves every matrix profile', async () => {
  for (const name of EVIDENCE) assert.deepEqual(assess(await load(name)), { proved: true, failures: [] }, name);
  const verdict = await assessMatrix(matrixPath);
  assert.deepEqual(verdict.failures, []);
});

test('a leak in the selected handoff fails the proof', async () => {
  const evidence = await load(EVIDENCE[0]);
  const trial = selected(evidence);
  trial.observer.hits.push({ pid: trial.observer.processes.find(p => p.layer === 'browser').pid, field: 'cmdline', sample: '<CANARY>' });
  assert.match(assess(evidence).failures.join('\n'), /credential observable: cmdline@/);
});

test('an observer that cannot see the negative-control leak invalidates the proof', async () => {
  const evidence = await load(EVIDENCE[0]);
  control(evidence).observer.hits = [];
  assert.match(assess(evidence).failures.join('\n'), /observer blind/);
});

test('a same-user or capable observer is not cross-user evidence', async () => {
  const evidence = await load(EVIDENCE[1]);
  selected(evidence).observer.observerUid = evidence.targetUid;
  control(evidence).observer.observerCapEff = '000001ffffffffff';
  const failures = assess(evidence).failures.join('\n');
  assert.match(failures, /ran as the launching user/);
  assert.match(failures, /held capabilities/);
});

test('every process layer must be observed and the handoff file must stay unreadable', async () => {
  const evidence = await load(EVIDENCE[1]);
  const trial = selected(evidence);
  trial.observer.layers.opener = 0;
  const [path] = Object.keys(trial.observer.privateProbes);
  trial.observer.privateProbes[path].readable = 1;
  const failures = assess(evidence).failures.join('\n');
  assert.match(failures, /opener layer was never observed/);
  assert.match(failures, /could read private handoff path/);
});

test('undelivered or too few trials do not prove a profile', async () => {
  const evidence = await load(EVIDENCE[0]);
  selected(evidence).delivered = false;
  evidence.trials = evidence.trials.slice(0, 4);
  const failures = assess(evidence).failures.join('\n');
  assert.match(failures, /never reached the loopback exchange/);
  assert.match(failures, /need 3/);
});
