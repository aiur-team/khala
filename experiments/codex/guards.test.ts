import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { assertThreadMatches, DISPOSABLE_THREAD_ID, refuseIfHeld, runWithCleanup, spawnedLockHolder, TargetRefused, validateTarget, type Target } from './guards.js';
import { groupPids, stopProcess } from './proc.js';

const home = '/home/u';
const target: Target = {
  threadId: DISPOSABLE_THREAD_ID,
  workdir: '/home/u/.cache/khala-disposable/codex-target',
  rollout: `/home/u/.codex/sessions/2026/09/17/rollout-2026-09-17T19-38-42-${DISPOSABLE_THREAD_ID}.jsonl`,
  priorMarker: 'prior-marker-codex-alpha',
  scratchDir: '/home/u/scratch',
  outFile: '/home/u/scratch/live-run.json',
};
const refused = (reason: string) => (e: unknown) => e instanceof TargetRefused && e.reason === reason;

test('the designated disposable target is accepted', () => {
  assert.doesNotThrow(() => validateTarget(target, home));
});

test('any thread other than the designated disposable one is refused', () => {
  const other = '01a0abaf-0000-7000-8000-000000000000';
  assert.throws(() => validateTarget({ ...target, threadId: other, rollout: target.rollout.replace(DISPOSABLE_THREAD_ID, other) }, home),
    refused('thread_not_designated'));
});

test('a workdir outside the disposable root is refused, including via .. or a symlink', () => {
  assert.throws(() => validateTarget({ ...target, workdir: '/home/u/src/real-project' }, home), refused('workdir_outside_disposable_root'));
  assert.throws(() => validateTarget({ ...target, workdir: '/home/u/.cache/khala-disposable' }, home), refused('workdir_outside_disposable_root'));
  assert.throws(() => validateTarget({ ...target, workdir: '/home/u/.cache/khala-disposable/../../src' }, home), refused('workdir_not_normalized_absolute'));
  assert.throws(() => validateTarget(target, home, '/home/u/src/real-project'), refused('workdir_outside_disposable_root'));
  assert.throws(() => validateTarget({ ...target, workdir: 'relative/dir' }, home), refused('workdir_not_normalized_absolute'));
});

test('a rollout that is not the target thread\'s own session file is refused', () => {
  assert.throws(() => validateTarget({ ...target, rollout: `/tmp/x-${DISPOSABLE_THREAD_ID}.jsonl` }, home), refused('rollout_not_target'));
  assert.throws(() => validateTarget({ ...target, rollout: `/tmp/rollout-${DISPOSABLE_THREAD_ID}.jsonl` }, home), refused('rollout_outside_sessions'));
  assert.throws(() => validateTarget({ ...target, rollout: '/home/u/.codex/sessions/rollout-other.jsonl' }, home), refused('rollout_not_target'));
});

test('a prior marker outside the synthetic format is refused', () => {
  assert.throws(() => validateTarget({ ...target, priorMarker: 'my real secret' }, home), refused('prior_marker_invalid'));
});

test('a thread already held by another process is refused', () => {
  assert.doesNotThrow(() => refuseIfHeld(null));
  assert.throws(() => refuseIfHeld(4242), refused('held_by_another_executor'));
});

test('native thread metadata must name the target thread and workdir', () => {
  assert.doesNotThrow(() => assertThreadMatches({ id: DISPOSABLE_THREAD_ID, cwd: target.workdir }, target));
  assert.throws(() => assertThreadMatches({ id: DISPOSABLE_THREAD_ID, cwd: '/home/u/src/real-project' }, target), refused('thread_cwd_mismatch'));
  assert.throws(() => assertThreadMatches({ id: 'other', cwd: target.workdir }, target), refused('thread_id_mismatch'));
  assert.throws(() => assertThreadMatches(undefined, target), refused('thread_id_mismatch'));
});

test('the writer lock must be held by the executor group this driver spawned', () => {
  assert.equal(spawnedLockHolder(101, [100, 101]), 101);
  assert.throws(() => spawnedLockHolder(null, [100, 101]), refused('lock_not_held_by_spawned_executor'));
  assert.throws(() => spawnedLockHolder(999, [100, 101]), refused('lock_not_held_by_spawned_executor'));
});

test('a failed run stops every spawned executor before the error surfaces', async () => {
  const stopped: string[] = [];
  await assert.rejects(runWithCleanup(async () => { throw new Error('boom'); }, ['a', 'b'],
    async c => { stopped.push(c); }), /boom/);
  assert.deepEqual(stopped.sort(), ['a', 'b']);
  stopped.length = 0;
  assert.equal(await runWithCleanup(async () => 7, ['a'], async c => { stopped.push(c); }), 7);
  assert.deepEqual(stopped, []);
});

test('stopProcess empties a detached child\'s whole process group', async () => {
  // A launcher that forks a longer-lived child, like `codex` exec-ing its native binary.
  const child = spawn('sh', ['-c', 'sleep 60 & sleep 60; wait'], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 50 && groupPids(child.pid!).length < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(groupPids(child.pid!).length >= 2);
  const r = await stopProcess(child, 2000);
  assert.equal(r.groupEmpty, true);
  assert.deepEqual(groupPids(child.pid!), []);
});

test('the live driver calls every guard (live.ts reads stdin on import, so it is checked by source)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./live.ts', import.meta.url), 'utf8');
  const calls = (name: string) => src.split(`${name}(`).length - 1;
  assert.equal(calls('validateTarget'), 1);
  assert.equal(calls('refuseIfHeld'), 1);
  assert.equal(calls('assertThreadMatches'), 2, 'before and after resume');
  assert.equal(calls('spawnedLockHolder'), 1);
  assert.match(src, /runWithCleanup\(\(\) => main\(input\), spawned, stopGroup\)/);
});
