import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname);
const plugin = join(root, 'marketplace/plugins/khala-proof');

function run(args, stdin, env) {
  return new Promise(done => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-proof-'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({ runId: 'test', cliVersion: 'test', launch: 'test' }));
  return dir;
}

const env = dir => ({ KHALA_PROOF_STATE: dir });
const admin = (dir, ...args) => run([join(root, 'khala-admin.mjs'), args[0], dir, ...args.slice(1)], args.at(-1)?.stdin ?? '', {});
const release = (dir, message) => run([join(root, 'khala-admin.mjs'), 'release', dir], message, {});
const hook = (dir, input) => run([join(plugin, 'hooks/hook.mjs'), 'main'], JSON.stringify(input), env(dir));

async function mcp(dir, sessionId, name, args = {}) {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map(line => JSON.stringify(line)).join('\n');
  const result = await run([join(plugin, 'mcp/server.mjs')], `${lines}\n`, { ...env(dir), CLAUDE_CODE_SESSION_ID: sessionId });
  return JSON.parse(result.stdout.trim().split('\n')[1]).result.content[0].text;
}

async function events(dir) {
  return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function started(dir, sessionId) {
  await hook(dir, { session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' });
}

test('steer delivers at PostToolUse; the next khala call acknowledges once', async () => {
  const dir = await project();
  await admin(dir, 'mode', 'steer');
  await started(dir, 's1');
  await release(dir, 'STEER marker');
  const post = await hook(dir, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  const context = JSON.parse(post.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /untrusted="true"/);
  assert.match(context, /STEER marker/);
  assert.doesNotMatch(context, /bt_/, 'batch token must stay out of model context');
  await release(dir, 'SECOND marker');
  await hook(dir, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.equal((await events(dir)).filter(event => event.kind === 'acknowledged').length, 0, 'a hook pull is not an acknowledgement');
  assert.equal(await mcp(dir, 's1', 'khala_send', { text: 'reply' }), 'Sent to the Khala channel.');
  const acks = (await events(dir)).filter(event => event.kind === 'acknowledged');
  assert.deepEqual(acks.map(event => event.via), ['khala_send', 'khala_send']);
  await mcp(dir, 's1', 'khala_status');
  assert.equal((await events(dir)).filter(event => event.kind === 'acknowledged').length, 2);
});

test('sync ignores PostToolUse, delivers at Stop, and a second Stop is empty', async () => {
  const dir = await project();
  await started(dir, 's1');
  await release(dir, 'SYNC marker');
  const post = await hook(dir, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(post.stdout, '');
  const stop = JSON.parse((await hook(dir, { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false })).stdout);
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /SYNC marker/);
  await release(dir, 'LATER marker');
  const again = await hook(dir, { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(again.stdout, '');
});

test('async never pulls automatically; khala_read is bound to the Claude session ID', async () => {
  const dir = await project();
  await admin(dir, 'mode', 'async');
  await started(dir, 's1');
  await release(dir, 'ASYNC marker');
  assert.equal((await hook(dir, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash' })).stdout, '');
  assert.equal((await hook(dir, { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false })).stdout, '');
  assert.match(await mcp(dir, 'other-session', 'khala_read'), /not bound/);
  assert.match(await mcp(dir, 's1', 'khala_read'), /ASYNC marker/);
  const denied = (await events(dir)).filter(event => event.kind === 'denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].sessionId, 'other-session');
});

test('a new session fences the unacknowledged token and redelivers with a fresh one', async () => {
  const dir = await project();
  await admin(dir, 'mode', 'steer');
  await started(dir, 'old');
  const releaseId = (await release(dir, 'RESTART marker')).stdout.trim();
  await hook(dir, { session_id: 'old', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  const oldToken = join(dir, 'old.token');
  await admin(dir, 'keep-token', oldToken, releaseId);
  await started(dir, 'new');
  assert.equal((await admin(dir, 'replay-ack', 'new', oldToken)).stdout.trim(), 'stale_generation');
  const post = await hook(dir, { session_id: 'new', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /RESTART marker/);
  const newToken = join(dir, 'new.token');
  await admin(dir, 'keep-token', newToken, releaseId);
  assert.notEqual(await readFile(oldToken, 'utf8'), await readFile(newToken, 'utf8'));
  await mcp(dir, 'new', 'khala_status');
  assert.equal((await admin(dir, 'replay-ack', 'new', newToken)).stdout.trim(), 'duplicate');
  assert.equal((await hook(dir, { session_id: 'new', hook_event_name: 'PostToolUse', tool_name: 'Bash' })).stdout, '');
});

test('message bytes and raw tokens never reach the event log', async () => {
  const dir = await project();
  await admin(dir, 'mode', 'steer');
  await started(dir, 's1');
  await release(dir, 'SECRET-BODY $(touch pwned) "quoted"');
  await hook(dir, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await mcp(dir, 's1', 'khala_send', { text: 'SECRET-REPLY' });
  const log = await readFile(join(dir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(log, /SECRET-BODY|SECRET-REPLY|bt_/);
});

test('stop-long watcher wakes only while idle, content-free, and a synchronous hook claims', async () => {
  const dir = await project();
  await admin(dir, 'watch', 'stop-long', '20');
  await started(dir, 's1');
  await hook(dir, { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' });
  const watcher = run([join(plugin, 'hooks/hook.mjs'), 'watch-stop'], JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }), env(dir));
  await release(dir, 'WAKE marker while busy');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await events(dir)).filter(event => event.kind === 'wake').length, 0, 'no wake while busy');
  const stop = JSON.parse((await hook(dir, { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false })).stdout);
  assert.match(stop.reason, /WAKE marker while busy/, 'a normal Stop still delivers');
  await hook(dir, { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: true });
  await release(dir, 'WAKE marker while idle');
  const woke = await watcher;
  assert.equal(woke.code, 2);
  assert.doesNotMatch(woke.stderr, /WAKE marker/);
  const prompt = JSON.parse((await hook(dir, { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt_id: 'p2' })).stdout);
  assert.match(prompt.hookSpecificOutput.additionalContext, /WAKE marker while idle/);
});
