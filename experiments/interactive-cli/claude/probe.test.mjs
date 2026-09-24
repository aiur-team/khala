import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname);

function run(script, args, stdin = '', environment = {}) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [join(root, script), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function runHook(runDir, mode, input) {
  return run('probe-plugin/hooks/probe.mjs', [], JSON.stringify(input), {
    KHALA_PROOF_RUN_DIR: runDir,
    KHALA_PROOF_MODE: mode,
  });
}

test('explicit pull delivers once and acknowledged token cannot be restaged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  const session = 'session-a';
  const token = 'batch-a';
  const secret = 'message only on stdin';

  const staged = await run('stage-message.mjs', [dir, session, 'pull', token], secret);
  assert.equal(staged.code, 0, staged.stderr);
  assert.doesNotMatch(JSON.stringify([dir, session, 'pull', token]), /message only on stdin/);

  const pulled = await run('read-pending.mjs', [dir, session]);
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.equal(pulled.stdout, `[khala:${token}] ${secret}\n`);

  const acked = await run('ack-batch.mjs', [dir, session, 'pull', token]);
  assert.equal(acked.code, 0, acked.stderr);

  const duplicate = await run('stage-message.mjs', [dir, session, 'pull', token], secret);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /batch already acknowledged/);

  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.kind), ['explicit-pull', 'acknowledged']);
});

test('pull is scoped to the target session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  await run('stage-message.mjs', [dir, 'session-b', 'pull', 'batch-b'], 'for B');

  const wrong = await run('read-pending.mjs', [dir, 'session-a']);
  assert.equal(wrong.stdout, 'No pending channel messages.\n');

  const right = await run('read-pending.mjs', [dir, 'session-b']);
  assert.equal(right.stdout, '[khala:batch-b] for B\n');
});

test('empty pull succeeds before a pending directory exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  const result = await run('read-pending.mjs', [dir, 'session-a']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'No pending channel messages.\n');
});

test('active Stop guard leaves a sync batch pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  await run('stage-message.mjs', [dir, 'session-a', 'sync', 'batch-sync'], 'later');
  const result = await runHook(dir, 'sync', {
    hook_event_name: 'Stop',
    session_id: 'session-a',
    stop_hook_active: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');

  const pending = await readFile(join(dir, 'pending', 'session-a.sync.batch-sync.json'), 'utf8');
  assert.match(pending, /"message":"later"/);
});

test('rewake stderr is content-free and the next hook pulls structured context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  const secret = 'rewake payload must not reach stderr';
  await run('stage-message.mjs', [dir, 'session-a', 'rewake', 'batch-rewake'], secret);
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'session-a', prompt_id: 'prompt-a' };

  const wake = await runHook(dir, 'rewake', input);
  assert.equal(wake.code, 2);
  assert.equal(wake.stderr, 'Khala channel update available');
  assert.doesNotMatch(wake.stderr, /batch-rewake|rewake payload/);

  const delivery = await runHook(dir, 'rewake', { ...input, prompt_id: 'prompt-b' });
  assert.equal(delivery.code, 0, delivery.stderr);
  const output = JSON.parse(delivery.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(output.hookSpecificOutput.additionalContext, `[khala:batch-rewake] ${secret}`);
});

test('wrong-session acknowledgement cannot poison a batch token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  await run('stage-message.mjs', [dir, 'session-a', 'pull', 'batch-owned'], 'owned');
  await run('read-pending.mjs', [dir, 'session-a']);

  const wrong = await run('ack-batch.mjs', [dir, 'session-b', 'pull', 'batch-owned']);
  assert.notEqual(wrong.code, 0);
  await assert.rejects(access(join(dir, 'acked', 'batch-owned')));

  const right = await run('ack-batch.mjs', [dir, 'session-a', 'pull', 'batch-owned']);
  assert.equal(right.code, 0, right.stderr);
});
