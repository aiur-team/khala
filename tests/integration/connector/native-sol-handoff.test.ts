import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectNativeSolHandoff, nativeSolRolloutMatches,
  type NativeSolHandoff } from './native-sol-handoff';

const refused = { kind: 'blocked', code: 'native_sol_handoff_unproven' };

async function fixture() {
  const preflightRoot = await mkdtemp(path.join(os.tmpdir(), 'khala-42-handoff-'));
  const codexHome = path.join(preflightRoot, 'codex-home');
  const workdir = path.join(preflightRoot, 'workdir');
  const sessionId = '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856';
  const nativePid = process.pid;
  const statText = await readFile(`/proc/${nativePid}/stat`, 'utf8');
  const nativeStartTime = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/u)[19]!;
  const cgroup = (await readFile(`/proc/${nativePid}/cgroup`, 'utf8')).split('\n')
    .find(line => line.startsWith('0::'))!.slice(3);
  const sessionFile = path.join(codexHome, 'sessions', 'rollout-disposable.jsonl');
  await mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  await mkdir(workdir, { mode: 0o700 });
  await mkdir(path.join(preflightRoot, 'state'), { mode: 0o700 });
  const input: NativeSolHandoff = { sessionId, workdir, codexHome, preflightRoot, nativePid,
    nativeStartTime, preflightBindingId: 'binding-preflight', preflightGeneration: 0 };
  const scope = { nativePid, nativeStartTime, nativeExecutable: '/usr/bin/codex', sessionId, cgroup, codexHome,
    fixtureRoot: preflightRoot, sessionFile };
  const binding = { v: 1, harness: 'codex', sessionId,
    bindingId: input.preflightBindingId, generation: 0 };
  const rollout = [
    { type: 'session_meta', payload: { id: sessionId, cwd: workdir, cli_version: '0.157.1' } },
    { type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: workdir } },
  ];
  await writeFile(sessionFile, rollout.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
  await writeFile(path.join(preflightRoot, 'state', 'scope.json'), JSON.stringify(scope), { mode: 0o600 });
  await writeFile(path.join(preflightRoot, 'state', 'binding.json'), JSON.stringify(binding), { mode: 0o600 });
  return { input, scope, binding, rollout, sessionFile, root: preflightRoot };
}

test('native handoff refuses a different session, binding or generation', async () => {
  const held = await fixture();
  try {
    assert.deepEqual(await inspectNativeSolHandoff({ ...held.input, sessionId:
      '11a0b66b-ce0c-7ee3-823e-14ecdb9f2856' }, '0.157.1'), refused);
    assert.deepEqual(await inspectNativeSolHandoff({ ...held.input, preflightBindingId: 'foreign' }, '0.157.1'), refused);
    assert.deepEqual(await inspectNativeSolHandoff({ ...held.input, preflightGeneration: 1 }, '0.157.1'), refused);
  } finally { await rm(held.root, { recursive: true, force: true }); }
});

test('native transcript accepts a long Sol session but refuses a later model switch', () => {
  const sessionId = '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856';
  const workdir = '/tmp/disposable-sol';
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: sessionId,
    cwd: workdir, cli_version: '0.157.1' } });
  const sol = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: workdir } });
  const unrelated = JSON.stringify({ type: 'event_msg', payload: { padding: 'x'.repeat(70 * 1024) } });
  const longRollout = `${meta}\n${unrelated}\n${sol}\n`;
  assert.ok(Buffer.byteLength(longRollout) > 64 * 1024);
  assert.equal(nativeSolRolloutMatches(longRollout, sessionId, workdir, '0.157.1'), true);
  assert.equal(nativeSolRolloutMatches(longRollout.replace('0.157.1', '0.159.3'), sessionId, workdir,
    '0.159.3'), true);
  assert.equal(nativeSolRolloutMatches(longRollout, sessionId, workdir, '0.159.3'), false);
  assert.equal(nativeSolRolloutMatches(longRollout.replace('0.157.1', '0.159.2'), sessionId, workdir,
    '0.159.2'), false);
  const switched = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: workdir } });
  assert.equal(nativeSolRolloutMatches(`${longRollout}${switched}\n`, sessionId, workdir, '0.157.1'), false);
});

test('native handoff refuses changed process start time and non-Sol rollout', async () => {
  const held = await fixture();
  try {
    assert.deepEqual(await inspectNativeSolHandoff({ ...held.input, nativeStartTime: '1' }, '0.157.1'), refused);
    await writeFile(held.sessionFile, JSON.stringify({ type: 'turn_context',
      payload: { model: 'gpt-6-astra', cwd: held.input.workdir } }) + '\n', { mode: 0o600 });
    assert.deepEqual(await inspectNativeSolHandoff(held.input, '0.157.1'), refused);
  } finally { await rm(held.root, { recursive: true, force: true }); }
});

test('native handoff refuses a live unrelated process despite matching metadata', async () => {
  const held = await fixture();
  try {
    assert.equal((await readlink(`/proc/${process.pid}/exe`)).endsWith('/codex'), false);
    assert.deepEqual(await inspectNativeSolHandoff(held.input, '0.157.1'), refused);
  } finally { await rm(held.root, { recursive: true, force: true }); }
});
