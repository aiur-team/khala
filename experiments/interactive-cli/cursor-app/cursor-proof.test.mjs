// Drives the kit with Cursor-shaped hook and MCP input, then grades the
// resulting state directory. The trials here are synthetic fixtures for the
// verifier; they are never evidence and never live under evidence/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildMatrix, gradeTrial, loadTrial } from './verify.mjs';

const root = resolve(import.meta.dirname);
const admin = join(root, '../claude/khala-admin.mjs');
const VERSION = '3.1.15';
const CONVERSATION = 'conv-1';

function run(args, stdin, env = {}) {
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

async function trialDir(shape = 'local_chat') {
  const dir = await mkdtemp(join(tmpdir(), 'khala-cursor-proof-'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({
    runId: 'test', app: 'cursor', shape, cliVersion: VERSION, accountTier: 'pro', administratorPolicyScope: 'none', launch: 'test',
  }));
  return dir;
}

const sha = text => createHash('sha256').update(text).digest('hex');
const setMode = (dir, mode) => run([admin, 'mode', dir, mode], '');
const release = async (dir, text) => (await run([admin, 'release', dir], text)).stdout.trim();

function hook(dir, input, session) {
  const env = { KHALA_PROOF_STATE: dir, ...(session ? { KHALA_CURSOR_SESSION: session } : {}) };
  return run([join(root, 'kit/hook.mjs')], JSON.stringify({
    conversation_id: CONVERSATION, generation_id: 'g', cursor_version: VERSION, ...input,
  }), env);
}

const start = async (dir, sessionId) => JSON.parse((await hook(dir, { hook_event_name: 'sessionStart', session_id: sessionId, is_background_agent: false })).stdout);
const toolStart = (dir, session, id) => hook(dir, { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_use_id: id }, session);
const toolEnd = (dir, session, id, duration) => hook(dir, { hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: id, duration }, session);
const stop = (dir, session, loopCount = 0, status = 'completed') => hook(dir, { hook_event_name: 'stop', status, loop_count: loopCount }, session);

async function mcp(dir, session, name, { record = true } = {}) {
  if (record) await hook(dir, { hook_event_name: 'beforeMCPExecution', tool_name: name, mcp_server_name: 'khala' }, session);
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } },
  ].map(line => JSON.stringify(line)).join('\n');
  const result = await run([join(root, 'kit/mcp.mjs')], `${lines}\n`, { KHALA_PROOF_STATE: dir });
  return JSON.parse(result.stdout.trim().split('\n')[1]).result.content[0].text;
}

async function observe(dir, text, census = {}) {
  await writeFile(join(dir, 'observations.json'), JSON.stringify({
    census: { backgroundAgentsCreated: 0, cloudAgentsCreated: 0, khalaStartedModelProcesses: 0, ...census },
    modelContext: text === null ? [] : [{ conversationId: CONVERSATION, sha256: sha(text), observedAt: new Date().toISOString(), source: 'transcript' }],
  }));
}

const NONCE = 'KHALA-NONCE-7f3a';

// Delivered, restarted before acknowledgement, replayed, acknowledged, and
// silent after a further restart.
async function steerTrial() {
  const dir = await trialDir();
  await setMode(dir, 'steer');
  const { env } = await start(dir, 's1');
  assert.equal(env.KHALA_CURSOR_SESSION, 's1');
  await toolStart(dir, 's1', 't1');
  await release(dir, NONCE);
  const first = JSON.parse((await toolEnd(dir, 's1', 't1', 20_500)).stdout);
  assert.match(first.additional_context, /KHALA-NONCE-7f3a/);
  assert.doesNotMatch(first.additional_context, /bt_/, 'batch token stays out of model context');
  await observe(dir, NONCE);
  await start(dir, 's2');
  await toolStart(dir, 's2', 't2');
  assert.match(JSON.parse((await toolEnd(dir, 's2', 't2', 900)).stdout).additional_context, /KHALA-NONCE-7f3a/);
  assert.match(await mcp(dir, 's2', 'khala_status'), /listening mode steer/);
  await start(dir, 's3');
  await toolStart(dir, 's3', 't3');
  assert.equal((await toolEnd(dir, 's3', 't3', 900)).stdout, '');
  return dir;
}

async function syncTrial() {
  const dir = await trialDir();
  await start(dir, 's1');
  await release(dir, NONCE);
  assert.equal((await toolEnd(dir, 's1', 't1', 20_500)).stdout, '', 'sync ignores postToolUse');
  const follow = JSON.parse((await stop(dir, 's1')).stdout);
  assert.match(follow.followup_message, /KHALA-NONCE-7f3a/);
  await observe(dir, NONCE);
  await start(dir, 's2');
  assert.match(JSON.parse((await stop(dir, 's2')).stdout).followup_message, /KHALA-NONCE-7f3a/);
  assert.match(await mcp(dir, 's2', 'khala_status'), /listening mode sync/);
  await start(dir, 's3');
  assert.equal((await stop(dir, 's3')).stdout, '');
  return dir;
}

async function asyncTrial() {
  const dir = await trialDir();
  await setMode(dir, 'async');
  await start(dir, 's1');
  await release(dir, NONCE);
  assert.equal((await toolEnd(dir, 's1', 't1', 20_500)).stdout, '');
  assert.equal((await stop(dir, 's1')).stdout, '');
  assert.match(await mcp(dir, 's1', 'khala_read'), /KHALA-NONCE-7f3a/);
  await observe(dir, NONCE);
  await start(dir, 's2');
  assert.match(await mcp(dir, 's2', 'khala_read'), /KHALA-NONCE-7f3a/);
  assert.equal(await mcp(dir, 's2', 'khala_read'), 'No pending channel messages.');
  await start(dir, 's3');
  assert.equal(await mcp(dir, 's3', 'khala_read'), 'No pending channel messages.');
  return dir;
}

const grade = async (dir, mode, shape = 'local_chat') => gradeTrial(await loadTrial(dir), shape, mode);

test('each mode is provable by a complete trial of that mode only', async () => {
  const trials = { steer: await steerTrial(), sync: await syncTrial(), async: await asyncTrial() };
  for (const [mode, dir] of Object.entries(trials)) {
    assert.deepEqual(await grade(dir, mode), [], mode);
    for (const other of Object.keys(trials).filter(value => value !== mode)) {
      assert.ok((await grade(dir, other)).some(reason => reason.includes(`${other} released at`) || reason.includes('long')), `${mode} trial must not prove ${other}`);
    }
  }
});

test('a sync follow-up fires once per human turn and never after an aborted turn', async () => {
  const dir = await trialDir();
  await start(dir, 's1');
  await release(dir, 'first');
  assert.equal((await stop(dir, 's1', 0, 'aborted')).stdout, '');
  assert.equal((await stop(dir, 's1', 1)).stdout, '');
  assert.match(JSON.parse((await stop(dir, 's1', 0)).stdout).followup_message, /first/);
});

test('khala_read fails closed without the beforeMCPExecution caller record', async () => {
  const dir = await trialDir();
  await setMode(dir, 'async');
  await start(dir, 's1');
  await release(dir, NONCE);
  assert.match(await mcp(dir, 's1', 'khala_read', { record: false }), /not bound/);
  const denied = (await loadTrial(dir)).events.filter(event => event.kind === 'denied');
  assert.deepEqual(denied.map(event => event.reason), ['no_caller_record']);
  assert.match(await mcp(dir, 's1', 'khala_read'), /KHALA-NONCE-7f3a/);
});

test('a background agent session neither binds nor proves delivery', async () => {
  const dir = await steerTrial();
  const background = await hook(dir, { hook_event_name: 'sessionStart', session_id: 'bg', is_background_agent: true });
  assert.equal(background.stdout, '', 'a background agent gets no session binding');
  assert.ok((await grade(dir, 'steer')).includes('a background agent session ran during the trial'));

  const created = await steerTrial();
  await observe(created, NONCE, { backgroundAgentsCreated: 1 });
  assert.ok((await grade(created, 'steer')).includes('census backgroundAgentsCreated is 1, not 0'));
});

test('hook execution without a model-context sighting cannot pass', async () => {
  const dir = await steerTrial();
  await observe(dir, null);
  assert.ok((await grade(dir, 'steer')).some(reason => reason.includes('no released batch was seen in the chat\'s model context')));
  await observe(dir, 'a different nonce');
  assert.ok((await grade(dir, 'steer')).some(reason => reason.includes('model context')));
});

test('a delivery after acknowledgement across a restart cannot pass', async () => {
  const dir = await steerTrial();
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const acked = events.find(event => event.kind === 'acknowledged');
  await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), kind: 'released', sessionId: `${CONVERSATION}/s3`, boundary: 'postToolUse', tokenId: 'feedfacefeed', releaseIds: acked.releaseIds,
  })}\n`);
  assert.ok((await grade(dir, 'steer')).includes(`release ${acked.releaseIds[0]} was delivered again after acknowledgement`));
});

test('a trial without a restart before acknowledgement cannot pass', async () => {
  const dir = await trialDir();
  await setMode(dir, 'async');
  await start(dir, 's1');
  await release(dir, NONCE);
  await mcp(dir, 's1', 'khala_read');
  await mcp(dir, 's1', 'khala_status');
  await observe(dir, NONCE);
  assert.deepEqual(await grade(dir, 'async'), ['no restart between fetch and acknowledgement replayed the batch']);
});

test('steer needs the batch to arrive during a completed long tool', async () => {
  const dir = await trialDir();
  await setMode(dir, 'steer');
  await start(dir, 's1');
  await release(dir, NONCE);
  await toolStart(dir, 's1', 't1');
  await toolEnd(dir, 's1', 't1', 20_500);
  assert.ok((await grade(dir, 'steer')).some(reason => reason.includes('20000 ms')), 'arrival before the tool started');
});

test('cloud evidence cannot prove a local cell, and version drift fails', async () => {
  const dir = await steerTrial();
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({ ...run, shape: 'cloud_task' }));
  assert.ok((await grade(dir, 'steer')).includes('a cloud_task trial cannot prove a local_chat cell'));

  const drift = await steerTrial();
  await writeFile(join(drift, 'run.json'), JSON.stringify({ ...run, cliVersion: '3.1.16' }));
  assert.ok((await grade(drift, 'steer')).includes(`hook ran under Cursor ${VERSION}, not the recorded 3.1.16`));
});

test('the retained matrix is exactly what the retained evidence grades to', async () => {
  const evidence = join(root, 'evidence');
  const retained = JSON.parse(await readFile(join(evidence, 'matrix.json'), 'utf8'));
  assert.deepEqual(retained, await buildMatrix(evidence));
  for (const shape of Object.values(retained)) {
    for (const cell of Object.values(shape)) assert.equal(cell.status, 'unknown');
  }
});
