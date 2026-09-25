#!/usr/bin/env node
// Assesses retained evidence and the supported-environment matrix. A profile is
// proven only when, across repeated trials, a separate unprivileged observer
// both caught the negative-control leak and saw no leak from the selected
// handoff while observing the launcher, opener, and browser layers.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MATCH_FIELDS, profileMismatch } from './lib/profile.mjs';

export const MIN_TRIALS = 3;
export const NEGATIVE_CONTROL = 'argv-url';
export const SELECTED = 'private-file';

// Failures for one trial against what its strategy must show.
export function trialFailures(trial) {
  const failures = [];
  const { layers, hits, privateProbes, environ, processes } = trial.observer;
  if (trial.strategy === NEGATIVE_CONTROL) {
    const leakingLayers = new Set(hits.map(h => processes.find(p => p.pid === h.pid)?.layer));
    for (const layer of ['opener', 'browser']) {
      if (!leakingLayers.has(layer)) failures.push(`negative control leak was not detected in ${layer} argv (observer blind)`);
    }
    return failures;
  }
  if (!trial.delivered) failures.push('credential never reached the loopback exchange');
  if (trial.leak || hits.length) {
    failures.push(`credential observable: ${hits.map(h => `${h.field}@${h.pid}`).join(', ') || 'launcher env'}`);
  }
  for (const layer of ['launcher', 'opener', 'browser']) {
    if (!layers[layer]) failures.push(`${layer} layer was never observed`);
  }
  // A denial must actually be observed: a probe that only ever saw ENOENT (a
  // missing mount, a wrong path, a file already gone) proves nothing.
  const denied = (what, outcomes) => {
    const unexpected = Object.keys(outcomes).filter(k => !['EACCES', 'ENOENT', 'ESRCH'].includes(k));
    if (unexpected.length) failures.push(`observer ${what}: ${unexpected.join(', ')}`);
    else if (!outcomes.EACCES) failures.push(`observer was never denied ${what}`);
  };
  denied('target environments', environ);
  for (const [path, outcomes] of Object.entries(privateProbes)) denied(`private handoff path ${path}`, outcomes);
  if (!Object.keys(privateProbes).length) failures.push('private handoff path was never probed');
  return failures;
}

export function assess(evidence) {
  const failures = [];
  const { observer } = evidence;
  if (observer?.kind !== 'docker') failures.push('observer was not a separate OS user');
  for (const trial of evidence.trials) {
    const report = trial.observer;
    const uid = report.observerUid;
    if (!Number.isInteger(uid) || uid === 0 || uid === evidence.targetUid) {
      failures.push('observer was not a separate unprivileged user');
    }
    if (report.observerCapEff !== '0000000000000000') failures.push('observer held capabilities');
    const ownUid = report.processes.find(p => p.layer === 'launcher')?.uid;
    if (ownUid !== evidence.targetUid) failures.push('launcher process was not observed under the target uid');
  }
  for (const strategy of [NEGATIVE_CONTROL, SELECTED]) {
    const trials = evidence.trials.filter(t => t.strategy === strategy);
    if (trials.length < MIN_TRIALS) failures.push(`${strategy}: ${trials.length} trials, need ${MIN_TRIALS}`);
    trials.forEach((t, i) => {
      for (const f of trialFailures(t)) failures.push(`${strategy}[${i}]: ${f}`);
    });
  }
  if (evidence.profile.handoff !== SELECTED) failures.push(`profile handoff is not ${SELECTED}`);
  return { proved: failures.length === 0, failures: [...new Set(failures)] };
}

// Every `proven` matrix entry must carry passing evidence for exactly its profile.
export async function assessMatrix(matrixPath) {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const failures = [];
  for (const entry of matrix.profiles) {
    if (entry.status !== 'proven') continue;
    if (!entry.evidence) {
      failures.push(`${entry.id}: proven without evidence`);
      continue;
    }
    const evidence = JSON.parse(await readFile(resolve(dirname(matrixPath), entry.evidence), 'utf8'));
    const verdict = assess(evidence);
    failures.push(...verdict.failures.map(f => `${entry.id}: ${f}`));
    const mismatch = profileMismatch(entry.profile, evidence.profile);
    if (mismatch) failures.push(`${entry.id}: matrix profile ${mismatch}`);
  }
  return { proved: failures.length === 0, failures, matchFields: MATCH_FIELDS };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ?? new URL('./matrix.json', import.meta.url).pathname;
  const verdict = target.endsWith('matrix.json')
    ? await assessMatrix(target)
    : assess(JSON.parse(await readFile(target, 'utf8')));
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.proved ? 0 : 1);
}
