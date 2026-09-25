import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const hook = join(root, 'hooks', 'probe.mjs');

function runHook(runDir, sessionId, hookEventName = 'PostToolUse', inputFields = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      env: { ...process.env, KHALA_HOOK_PROBE_DIR: runDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({
      ...inputFields,
      session_id: sessionId,
      hook_event_name: hookEventName,
      cwd: inputFields.cwd ?? '/same/worktree',
      tool_name: inputFields.tool_name ?? 'Bash',
    }));
  });
}

test('concurrent hooks claim one item once and never cross sessions sharing a cwd', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'khala-hook-probe-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  await mkdir(join(runDir, 'pending'));

  await writeFile(join(runDir, 'pending', 'session-a.post-tool.json'), JSON.stringify({ message: 'for-a' }));
  await writeFile(join(runDir, 'pending', 'session-b.post-tool.json'), JSON.stringify({ message: 'for-b' }));

  const contenders = await Promise.all([
    runHook(runDir, 'session-a'),
    runHook(runDir, 'session-a'),
  ]);

  assert.deepEqual(contenders.map(result => result.code), [0, 0]);
  assert.equal(contenders.filter(result => result.stdout.includes('for-a')).length, 1);
  assert.equal(contenders.some(result => result.stdout.includes('for-b')), false);

  const other = await runHook(runDir, 'session-b');
  assert.equal(other.code, 0);
  assert.match(other.stdout, /for-b/);

  const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.cwd), ['/same/worktree', '/same/worktree', '/same/worktree']);
  assert.equal(events.filter(event => event.sessionId === 'session-a').length, 2);
  assert.equal(events.filter(event => event.sessionId === 'session-b').length, 1);
});

test('Stop drains its session item with Stop-specific hook output', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'khala-hook-probe-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  await mkdir(join(runDir, 'pending'));
  await writeFile(join(runDir, 'pending', 'session-stop.stop.json'), JSON.stringify({ message: 'wrap up' }));

  const result = await runHook(runDir, 'session-stop', 'Stop', { stop_hook_active: false });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: '[khala-probe:stop] wrap up',
    },
  });
});

test('UserPromptSubmit wakes immediately through stderr when a rewake item is staged', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'khala-hook-probe-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  await mkdir(join(runDir, 'pending'));
  await writeFile(join(runDir, 'pending', 'session-rewake.rewake.json'), JSON.stringify({ message: 'resume now' }));

  const result = await runHook(runDir, 'session-rewake', 'UserPromptSubmit', { prompt_id: 'prompt-1' });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '[khala-probe:rewake] resume now');
});
