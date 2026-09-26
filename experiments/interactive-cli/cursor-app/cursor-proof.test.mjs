// Drives the kit with Cursor-shaped hook and MCP input, then grades the
// resulting state directory. The trials here are synthetic fixtures for the
// verifier; they are never evidence and never live under evidence/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { BOUNDARY, buildMatrix, gradeTrial, loadTrial } from './verify.mjs';

const root = resolve(import.meta.dirname);
const admin = join(root, '../claude/khala-admin.mjs');
const VERSION = '3.1.15';
const CONVERSATION = 'conv-1';
const INIT = { pid: 1, ppid: 0, argv: ['/sbin/init'] };
const APP = { pid: 4242, ppid: 1, argv: ['/usr/share/cursor/cursor', '/home/person/scratch'] };
const RENDERER = { pid: 4243, ppid: 4242, argv: ['/usr/share/cursor/cursor', '--type=renderer'] };
const KHALA = { pid: 5000, ppid: 1, argv: ['node', '/usr/lib/node_modules/@aiur/khala/dist/cli.js', 'run'] };

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

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

// What record-launch.mjs writes for a person who opened Cursor themselves with
// an allowlist and MCP auto-run off.
async function recordLaunch(dir, { app = APP, ancestors = [INIT], trust = {} } = {}) {
  await writeFile(join(dir, 'launch.json'), JSON.stringify({
    recordedAt: new Date().toISOString(),
    app: { ...app, ancestors },
    trust: { autoRun: 'allowlist', mcpAutoRun: 'off', ...trust },
  }));
  const runJson = await readJson(join(dir, 'run.json'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({ ...runJson, launch: app.argv }));
}

async function trialDir(shape = 'local_chat') {
  const dir = await mkdtemp(join(tmpdir(), 'khala-cursor-proof-'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({
    runId: 'test', app: 'cursor', shape, cliVersion: VERSION, accountTier: 'pro', administratorPolicyScope: 'none',
  }));
  await recordLaunch(dir);
  return dir;
}

// What census.mjs writes, from a synthetic process list.
const snapshot = (dir, extra = [], base = [INIT, APP, RENDERER]) => writeFile(join(dir, 'census.json'), JSON.stringify({
  at: new Date().toISOString(), platform: 'linux', processes: [...base, ...extra],
}));

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

const sighting = (text, observedAt = new Date().toISOString()) => ({ conversationId: CONVERSATION, sha256: sha(text), observedAt, source: 'transcript' });

async function observe(dir, text) {
  await writeFile(join(dir, 'observations.json'), JSON.stringify({ modelContext: text === null ? [] : [sighting(text)] }));
}

const NONCE = 'KHALA-NONCE-7f3a';
const IDLE_NONCE = 'KHALA-NONCE-idle-9c1e';

// Delivered, restarted before acknowledgement, replayed, acknowledged, and
// silent after a further restart.
async function steerTrial() {
  const dir = await trialDir();
  await setMode(dir, 'steer');
  const { env } = await start(dir, 's1');
  assert.equal(env.KHALA_CURSOR_SESSION, 's1');
  await snapshot(dir);
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
  await snapshot(dir);
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
  await snapshot(dir);
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

// The kit has no idle wake, so no real trial produces this. Appending what a
// working wake would log shows the idle check accepts a genuine idle delivery:
// the turn ends, a batch arrives, and it reaches model context and is
// acknowledged with no prompt or tool in between.
async function idleWake(dir, mode, { promptFirst = false } = {}) {
  await stop(dir, 's3');
  await release(dir, IDLE_NONCE);
  const { events } = await loadTrial(dir);
  const arrival = events.findLast(event => event.kind === 'arrived');
  const at = offset => new Date(Date.now() + offset).toISOString();
  const common = { runId: 'test', cliVersion: VERSION, launch: APP.argv, conversationId: CONVERSATION };
  await appendFile(join(dir, 'events.jsonl'), [
    { at: at(1000), kind: 'released', ...common, sessionId: `${CONVERSATION}/s3`, boundary: BOUNDARY[mode], releaseIds: [arrival.releaseId] },
    ...(promptFirst ? [{ at: at(1500), kind: 'user-prompt', ...common, sessionKey: `${CONVERSATION}/s3` }] : []),
    { at: at(3000), kind: 'acknowledged', ...common, sessionId: `${CONVERSATION}/s3`, via: 'khala_status', releaseIds: [arrival.releaseId] },
  ].map(event => `${JSON.stringify(event)}\n`).join(''));
  const observations = await readJson(join(dir, 'observations.json'));
  observations.modelContext.push(sighting(IDLE_NONCE, at(2000)));
  await writeFile(join(dir, 'observations.json'), JSON.stringify(observations));
  return dir;
}

const grade = async (dir, mode, shape = 'local_chat') => gradeTrial(await loadTrial(dir), shape, mode);
const IDLE_REASON = mode => `${mode} has no idle-session trial: no batch that arrived while the chat sat idle reached model context before the next turn`;

test('each mode is provable by a complete trial of that mode only', async () => {
  const trials = { steer: await steerTrial(), sync: await syncTrial(), async: await asyncTrial() };
  assert.deepEqual(await grade(trials.async, 'async'), []);
  // The kit has no idle route, so a complete steer or sync trial still fails on idle delivery alone.
  for (const mode of ['steer', 'sync']) assert.deepEqual(await grade(trials[mode], mode), [IDLE_REASON(mode)], mode);
  for (const [mode, dir] of Object.entries(trials)) {
    for (const other of Object.keys(trials).filter(value => value !== mode)) {
      assert.ok((await grade(dir, other)).some(reason => reason.includes(`${other} released at`) || reason.includes('long')), `${mode} trial must not prove ${other}`);
    }
  }
});

test('steer and sync need a batch delivered to an idle chat', async () => {
  for (const [mode, trial] of [['steer', steerTrial], ['sync', syncTrial]]) {
    assert.deepEqual(await grade(await idleWake(await trial(), mode), mode), [], `${mode} with an idle delivery`);

    // Reaching model context only after the person's next prompt is not idle delivery.
    const prompted = await idleWake(await trial(), mode, { promptFirst: true });
    assert.deepEqual(await grade(prompted, mode), [IDLE_REASON(mode)], `${mode} after a prompt`);
  }
});

test('the prompt text never reaches the event log', async () => {
  const dir = await trialDir();
  await start(dir, 's1');
  await hook(dir, { hook_event_name: 'beforeSubmitPrompt', prompt: 'secret person prompt' }, 's1');
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
  assert.match(raw, /"kind":"user-prompt"/);
  assert.doesNotMatch(raw, /secret person prompt/);
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
  const dir = await asyncTrial();
  const background = await hook(dir, { hook_event_name: 'sessionStart', session_id: 'bg', is_background_agent: true });
  assert.equal(background.stdout, '', 'a background agent gets no session binding');
  assert.ok((await grade(dir, 'async')).includes('a background agent session ran during the trial'));
});

test('a second Cursor conversation cannot pass', async () => {
  const dir = await asyncTrial();
  await hook(dir, { hook_event_name: 'sessionStart', session_id: 'other', is_background_agent: false, conversation_id: 'conv-2' });
  assert.ok((await grade(dir, 'async')).includes('hooks saw 2 Cursor conversations, not exactly the person\'s one chat'));
});

test('the census is derived from the raw process list', async () => {
  const dir = await asyncTrial();
  await snapshot(dir, [KHALA, { pid: 5001, ppid: 5000, argv: ['cursor-agent', '-p', '--force', 'hi'] }]);
  const reasons = await grade(dir, 'async');
  assert.ok(reasons.includes('census Cursor process 5001 has a Khala ancestor 5000: cursor-agent -p --force hi'));
  assert.ok(reasons.includes('census shows a headless Cursor agent, a second model session: cursor-agent -p --force hi'));
  assert.ok(reasons.includes('census Cursor process 5001 bypasses normal trust settings (--force): cursor-agent -p --force hi'));

  const missing = await asyncTrial();
  await writeFile(join(missing, 'census.json'), JSON.stringify({ at: new Date().toISOString() }));
  assert.ok((await grade(missing, 'async')).includes('no raw process census'));

  const early = await asyncTrial();
  await writeFile(join(early, 'census.json'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', processes: [INIT, APP] }));
  assert.ok((await grade(early, 'async')).includes('the process census was not taken during the trial'));
});

test('the launch must be recorded, with normal trust settings (decision 33)', async () => {
  const unrecorded = await asyncTrial();
  await rm(join(unrecorded, 'launch.json'));
  assert.ok((await grade(unrecorded, 'async')).includes('launch.json was not recorded'));
  await writeFile(join(unrecorded, 'launch.json'), '{}');
  assert.ok((await grade(unrecorded, 'async')).includes('launch.json does not record the Cursor desktop app process'));

  const runEverything = await asyncTrial();
  await recordLaunch(runEverything, { trust: { autoRun: 'run-everything', mcpAutoRun: 'on' } });
  const trust = await grade(runEverything, 'async');
  assert.ok(trust.includes('auto-run setting "run-everything" is not a normal trust setting'));
  assert.ok(trust.includes('MCP auto-run is "on", not off'));

  // A launch recorded after the fact does not match what every event carried.
  const yolo = { ...APP, argv: ['/usr/share/cursor/cursor', '--yolo'] };
  const bypass = await asyncTrial();
  await snapshot(bypass, [], [INIT, yolo]);
  await recordLaunch(bypass, { app: yolo });
  const bypassed = await grade(bypass, 'async');
  assert.ok(bypassed.includes('launch command bypasses normal trust settings (--yolo)'));
  assert.ok(bypassed.some(reason => /events do not carry the recorded launch command/.test(reason)));
  assert.ok(bypassed.includes('the launch was recorded after the first batch arrived'));

  const underKhala = { pid: 5001, ppid: 5000, argv: ['/usr/share/cursor/cursor', '--force', '/home/person/scratch'] };
  const spawned = await trialDir();
  await recordLaunch(spawned, { app: underKhala, ancestors: [KHALA, INIT] });
  await setMode(spawned, 'async');
  await start(spawned, 's1');
  await snapshot(spawned, [], [INIT, KHALA, underKhala]);
  const reasons = await grade(spawned, 'async');
  assert.ok(reasons.includes('launch command bypasses normal trust settings (--force)'));
  assert.ok(reasons.includes('the Cursor app was started under Khala process 5000'));

  const elsewhere = await asyncTrial();
  await snapshot(elsewhere, [], [INIT]);
  assert.ok((await grade(elsewhere, 'async')).includes('the recorded launch command is not a running Cursor app process in the census'));
});

test('combined short flags cannot hide a headless or bypassing agent', async () => {
  for (const flags of ['-pf', '-fp']) {
    const dir = await asyncTrial();
    await snapshot(dir, [{ pid: 6001, ppid: 4242, argv: ['cursor-agent', flags, 'hi'] }]);
    const reasons = await grade(dir, 'async');
    assert.ok(reasons.includes(`census shows a headless Cursor agent, a second model session: cursor-agent ${flags} hi`), flags);
    assert.ok(reasons.includes(`census Cursor process 6001 bypasses normal trust settings (-f): cursor-agent ${flags} hi`), flags);
  }
});

test('a Cursor process is found anywhere in argv, and its parent must be in the census', async () => {
  const wrapped = await asyncTrial();
  const node = { pid: 6002, ppid: 5000, argv: ['node', '--use-system-ca', '/home/person/.local/share/cursor-agent/versions/1/index.js', '-p', 'hi'] };
  await snapshot(wrapped, [KHALA, node]);
  const reasons = await grade(wrapped, 'async');
  assert.ok(reasons.includes(`census Cursor process 6002 has a Khala ancestor 5000: ${node.argv.join(' ')}`));
  assert.ok(reasons.includes(`census shows a headless Cursor agent, a second model session: ${node.argv.join(' ')}`));

  const orphan = await asyncTrial();
  await snapshot(orphan, [{ pid: 6003, ppid: 7777, argv: ['cursor-agent', '--resume', 'chat-1'] }]);
  assert.ok((await grade(orphan, 'async')).includes('census Cursor process 6003 has parent 7777, which is not in the census: cursor-agent --resume chat-1'));
});

test('only the Cursor desktop app can prove local_chat, never a CLI session', async () => {
  const shapes = [
    ['cursor-agent', '--resume', 'chat-1'],
    ['node', '/home/person/.local/share/cursor-agent/versions/1/index.js', '--resume', 'chat-1'],
    ['/usr/bin/cursor', 'agent', '--resume', 'chat-1'],
    ['/usr/share/cursor/cursor', '--type=renderer'],
  ];
  for (const argv of shapes) {
    const cli = { pid: 4242, ppid: 1, argv };
    const dir = await trialDir();
    await recordLaunch(dir, { app: cli });
    await setMode(dir, 'async');
    await start(dir, 's1');
    await snapshot(dir, [], [INIT, cli]);
    assert.ok((await grade(dir, 'async')).includes('launch.json does not record the Cursor desktop app process'), argv.join(' '));
  }
});

test('hook execution without a model-context sighting cannot pass', async () => {
  const dir = await asyncTrial();
  await observe(dir, null);
  assert.ok((await grade(dir, 'async')).some(reason => reason.includes('no released batch was seen in the chat\'s model context')));
  await observe(dir, 'a different nonce');
  assert.ok((await grade(dir, 'async')).some(reason => reason.includes('model context')));
});

test('a delivery after acknowledgement across a restart cannot pass', async () => {
  const dir = await steerTrial();
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const acked = events.find(event => event.kind === 'acknowledged');
  await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), kind: 'released', sessionId: `${CONVERSATION}/s3`, boundary: 'postToolUse', tokenId: 'feedfacefeed', releaseIds: acked.releaseIds, launch: APP.argv,
  })}\n`);
  assert.ok((await grade(dir, 'steer')).includes(`release ${acked.releaseIds[0]} was delivered again after acknowledgement`));
});

test('a delivery no agent call acknowledged cannot pass', async () => {
  const dir = await trialDir();
  await setMode(dir, 'steer');
  await start(dir, 's1');
  await snapshot(dir);
  await toolStart(dir, 's1', 't1');
  await release(dir, NONCE);
  await toolEnd(dir, 's1', 't1', 20_500);
  await observe(dir, NONCE);
  await start(dir, 's2');
  await toolStart(dir, 's2', 't2');
  await toolEnd(dir, 's2', 't2', 900);
  assert.ok((await grade(dir, 'steer')).includes('no batch token was acknowledged by a later agent call'));
});

test('a trial without a restart before acknowledgement cannot pass', async () => {
  const dir = await trialDir();
  await setMode(dir, 'async');
  await start(dir, 's1');
  await snapshot(dir);
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
  const dir = await asyncTrial();
  const runJson = await readJson(join(dir, 'run.json'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({ ...runJson, shape: 'cloud_task' }));
  assert.ok((await grade(dir, 'async')).includes('a cloud_task trial cannot prove a local_chat cell'));

  const drift = await asyncTrial();
  await writeFile(join(drift, 'run.json'), JSON.stringify({ ...runJson, cliVersion: '3.1.16' }));
  assert.ok((await grade(drift, 'async')).includes(`hook ran under Cursor ${VERSION}, not the recorded 3.1.16`));
});

test('a cloud trial needs the existing cloud agent, created before the trial', async () => {
  const dir = await asyncTrial();
  await writeFile(join(dir, 'launch.json'), JSON.stringify({
    recordedAt: '2020-01-01T00:00:00.000Z', cloudAgent: { id: 'bc-1', createdAt: new Date().toISOString() }, trust: { autoRun: 'ask', mcpAutoRun: 'off' },
  }));
  assert.ok((await grade(dir, 'async', 'cloud_task')).includes('the cloud agent was not created before the trial'));
});

test('census.mjs and record-launch.mjs capture real processes', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'khala-cursor-proof-'));
  await writeFile(join(dir, 'run.json'), JSON.stringify({ runId: 'test', app: 'cursor' }));
  const own = (await readFile(`/proc/${process.pid}/cmdline`, 'utf8')).replace(/\0$/, '').split('\0');
  const recorded = await run([join(root, 'kit/record-launch.mjs'), dir, '--app-pid', String(process.pid), '--auto-run', 'run-everything', '--mcp-auto-run', 'on'], '');
  assert.equal(recorded.code, 0, recorded.stderr);
  const launch = await readJson(join(dir, 'launch.json'));
  assert.deepEqual(launch.app.argv, own);
  assert.equal(launch.app.ancestors[0].pid, launch.app.ppid);
  // It records what happened; the verifier rejects the bypass.
  assert.deepEqual(launch.trust, { autoRun: 'run-everything', mcpAutoRun: 'on' });
  assert.deepEqual((await readJson(join(dir, 'run.json'))).launch, own);

  assert.equal((await run([join(root, 'kit/census.mjs'), dir], '')).code, 0);
  const census = await readJson(join(dir, 'census.json'));
  assert.deepEqual(census.processes.find(proc => proc.pid === process.pid)?.argv, own);
});

test('the retained matrix is exactly what the retained evidence grades to', async () => {
  const evidence = join(root, 'evidence');
  const retained = await readJson(join(evidence, 'matrix.json'));
  assert.deepEqual(retained, await buildMatrix(evidence));
  for (const shape of Object.values(retained)) {
    for (const cell of Object.values(shape)) assert.equal(cell.status, 'unknown');
  }
});
