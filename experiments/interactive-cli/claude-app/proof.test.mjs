// Kit and checker tests. The MCP clients here are test drivers standing in for
// the app; their runs exercise the checker and are never evidence.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { startHttp } from './server/http.mjs';
import { MAX_BATCH } from './lib/store.mjs';
import { verify } from './verify.mjs';

const root = resolve(import.meta.dirname);
const identity = shape => ({
  runId: 'test', app: 'claude', shape, appVersion: '0.0.0-test', accountTier: 'test-tier',
  administratorPolicyScope: 'test-policy', os: 'test-os', launch: 'test driver',
  expectedClientNames: ['claude-ai'], targetConversations: ['test-conversation'],
});

async function stateDir(shape = 'desktop_extension') {
  const dir = await mkdtemp(join(tmpdir(), 'khala-claude-app-'));
  await writeFile(join(dir, 'run.json'), JSON.stringify(identity(shape)));
  return dir;
}

function node(args, stdin = '') {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => (code === 0 ? done(stdout) : failed(new Error(stderr))));
    child.stdin.end(stdin);
  });
}

const admin = (dir, ...args) => node([join(root, 'khala-admin.mjs'), args[0], dir, ...args.slice(1)]);
const release = async (dir, message) => (await node([join(root, 'khala-admin.mjs'), 'release', dir], message)).trim();

// One stdio server process = one desktop-extension connection.
function stdioClient(dir, clientName = 'claude-ai') {
  const child = spawn(process.execPath, [join(root, 'server/stdio.mjs')], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, KHALA_PROOF_STATE: dir },
  });
  const waiting = new Map();
  const notifications = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) notifications.push(message);
    else waiting.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method, params) => new Promise(done => {
    next += 1;
    waiting.set(next, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });
  return {
    notifications,
    initialize: () => request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '0.0.0-test' } }),
    read: async ackBatchToken => (await request('tools/call', {
      name: 'khala_read', arguments: ackBatchToken === undefined ? {} : { ackBatchToken },
    })).result.content[0].text,
    close: () => new Promise(done => { child.on('close', done); child.stdin.end(); }),
  };
}

const tokenIn = text => text.match(/batchToken: (bt_[0-9a-f]+)/)?.[1];

async function events(dir) {
  return (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function verdict(dir) {
  return verify(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')), await events(dir));
}

// Drives the full async procedure: fetch, restart before ack (replay), ack on
// the next call, echo observation, restart after ack.
async function fullAsyncRun(dir, { client = 'claude-ai', ackClient = client } = {}) {
  const releaseId = await release(dir, 'ASYNC marker 7f3c');
  const first = stdioClient(dir, client);
  await first.initialize();
  const token = tokenIn(await first.read());
  await first.close();
  await admin(dir, 'observe', 'restart', 'phase=before-ack');
  const second = stdioClient(dir, ackClient);
  await second.initialize();
  assert.equal(tokenIn(await second.read()), token, 'unacknowledged batch replays with the same token');
  await admin(dir, 'observe', 'model-echo', `release=${releaseId}`, 'conversation=test-conversation');
  await second.read(token);
  await second.close();
  await admin(dir, 'observe', 'restart', 'phase=after-ack');
  const third = stdioClient(dir, client);
  await third.initialize();
  const after = await third.read();
  await third.close();
  return { releaseId, token, after };
}

test('fetching never acknowledges; the next call acknowledges by token exactly once', async () => {
  const dir = await stateDir();
  await release(dir, 'marker one');
  const client = stdioClient(dir);
  await client.initialize();
  const first = await client.read();
  assert.match(first, /marker one/);
  assert.match(first, /untrusted="true"/);
  const token = tokenIn(first);
  assert.equal(tokenIn(await client.read()), token, 'a second fetch replays the unacknowledged batch');
  assert.match(await client.read(token), /^Batch acknowledged\.\nNo pending channel messages\./);
  assert.equal(await client.read(token), 'No pending channel messages.', 'a replayed ack neither re-acknowledges nor redelivers');
  await client.close();
  const log = await events(dir);
  assert.equal(log.filter(e => e.kind === 'acknowledged').length, 1);
  assert.equal(log.find(e => e.kind === 'ack-rejected').result, 'duplicate');
});

test('batches are bounded and leave in arrival order', async () => {
  const dir = await stateDir();
  const ids = [];
  for (let i = 0; i < MAX_BATCH + 2; i += 1) ids.push(await release(dir, `m${i}`));
  const client = stdioClient(dir);
  await client.initialize();
  const first = await client.read();
  const second = await client.read(tokenIn(first));
  await client.close();
  const seen = [...`${first}\n${second}`.matchAll(/\[release (r_[0-9a-f]+)/g)].map(m => m[1]);
  assert.deepEqual(seen, ids);
  assert.equal((first.match(/\[release /g) ?? []).length, MAX_BATCH);
});

test('payload bytes and raw batch tokens never reach the event log', async () => {
  const dir = await stateDir();
  const { token } = await fullAsyncRun(dir);
  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /ASYNC marker/);
  assert.equal(raw.includes(token), false);
});

test('remote connector speaks Streamable HTTP with a per-connection session id', async () => {
  const dir = await stateDir('remote_connector');
  await release(dir, 'HTTP marker');
  const server = await startHttp({ stateDir: dir });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const post = (body, session) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(body),
  });
  try {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-ai', version: 't' } } });
    const session = init.headers.get('mcp-session-id');
    assert.match(session, /^c_/);
    const call = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'khala_read', arguments: {} } }, session)).json();
    assert.match(call.result.content[0].text, /HTTP marker/);
    assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'c_forged')).status, 404);
    assert.equal((await fetch(url)).status, 405);
  } finally {
    server.close();
  }
  assert.equal((await events(dir)).find(e => e.kind === 'connected').transport, 'http');
});

test('a complete explicit pull run proves async only, for the exact tuple', async () => {
  const dir = await stateDir();
  const { after } = await fullAsyncRun(dir);
  assert.equal(after, 'No pending channel messages.', 'no duplicate after acknowledgement and restart');
  const result = await verdict(dir);
  assert.deepEqual(result.failures, []);
  assert.equal(result.modes.async.status, 'proven');
  assert.equal(result.modes.async.testedVersion, '0.0.0-test');
  assert.equal(result.acknowledgement, 'batch_token_next_call');
  assert.equal(result.modes.steer.status, 'unknown');
  assert.equal(result.modes.sync.status, 'unknown');
});

test('wrong implementation: an MCP notification or tool-list change is not delivery', async () => {
  const dir = await stateDir();
  const releaseId = await release(dir, 'NOTIFY marker');
  const client = stdioClient(dir);
  try {
    await client.initialize();
    await admin(dir, 'notify', 'tools_list_changed');
    await admin(dir, 'notify', 'log_message');
    const deadline = Date.now() + 5000;
    while (client.notifications.length < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  } finally {
    await client.close();
  }
  assert.deepEqual(client.notifications.map(n => n.method), ['notifications/tools/list_changed', 'notifications/message']);
  assert.equal(JSON.stringify(client.notifications).includes('NOTIFY marker'), false, 'notifications carry no content');
  // Even with an operator claiming the model saw it, nothing is delivered.
  await admin(dir, 'observe', 'model-echo', `release=${releaseId}`, 'conversation=test-conversation');
  const result = await verdict(dir);
  assert.equal(result.modes.async.status, 'unknown');
  assert.equal(result.modes.steer.status, 'unknown');
  assert.equal(result.modes.sync.status, 'unknown');
  assert.match(result.ignoredSignals, /tools_list_changed/);
});

test('wrong implementation: an acknowledgement from a second Claude session cannot prove delivery', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir, { ackClient: 'claude-code' });
  const result = await verdict(dir);
  assert.equal(result.modes.async.status, 'unknown');
  assert.ok(result.failures.some(f => /"claude-code", not a declared Claude app client/.test(f)));
  assert.ok(result.failures.some(f => /more than one MCP client/.test(f)));
});

test('wrong implementation: a run from any undeclared or unnamed client proves nothing', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  for (const name of ['Claude Code', 'mcp-remote', 'gemini-cli', 'vscode', 'goose', '', '  ', undefined]) {
    const relabelled = log.map(e => (e.kind === 'connected' ? { ...e, clientInfo: { ...e.clientInfo, name } } : e));
    const result = verify(identity('desktop_extension'), relabelled);
    assert.equal(result.modes.async.status, 'unknown', `client ${JSON.stringify(name)}`);
    assert.ok(result.failures.some(f => /not a declared Claude app client/.test(f)), `client ${JSON.stringify(name)}`);
  }
});

test('wrong implementation: a known non-app client proves nothing even when run.json declares it', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  for (const name of ['claude-code', 'Claude Code', 'mcp-remote']) {
    const relabelled = log.map(e => (e.kind === 'connected' ? { ...e, clientInfo: { ...e.clientInfo, name } } : e));
    const result = verify({ ...identity('desktop_extension'), expectedClientNames: [name] }, relabelled);
    assert.equal(result.modes.async.status, 'unknown', `client ${JSON.stringify(name)}`);
    assert.ok(result.failures.some(f => /a known non-app MCP client/.test(f)), `client ${JSON.stringify(name)}`);
  }
});

test('a run without declared app clients or target conversations is not graded', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  for (const [key, value] of [['expectedClientNames', undefined], ['expectedClientNames', []], ['expectedClientNames', ['']],
    ['targetConversations', undefined], ['targetConversations', []], ['targetConversations', ['unknown']]]) {
    const result = verify({ ...identity('desktop_extension'), [key]: value }, log);
    assert.equal(result.modes.async.status, 'unknown', `${key}=${JSON.stringify(value)}`);
    assert.match(result.modes.async.reason, new RegExp(`identity incomplete: .*${key}`));
  }
});

test('wrong implementation: a run driven wholly by another Claude session (Claude Code) proves nothing', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir, { client: 'claude-code' });
  const result = await verdict(dir);
  assert.equal(result.modes.async.status, 'unknown');
  assert.ok(result.failures.some(f => /"claude-code", not a declared Claude app client/.test(f)));
});

test('an acknowledgement on a connection with no recorded client is not evidence', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = (await events(dir)).filter(e => e.kind !== 'connected');
  const result = verify(identity('desktop_extension'), log);
  assert.deepEqual(result.failures, []);
  assert.match(result.modes.async.reason, /identified app client/);
});

test('wrong implementation: stdio evidence cannot claim the browser or remote-connector shape', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const run = { ...identity('browser') };
  const result = verify(run, await events(dir));
  assert.equal(result.modes.async.status, 'unknown');
  assert.ok(result.failures.some(f => /not the browser transport/.test(f)));
});

test('missing model echo or restart replay leaves async unknown', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  const noEcho = verify(identity('desktop_extension'), log.filter(e => e.observation !== 'model-echo'));
  assert.equal(noEcho.modes.async.status, 'unknown');
  assert.match(noEcho.modes.async.reason, /no model-echo in a target conversation/);
  const noReplay = verify(identity('desktop_extension'), log.filter(e => !(e.kind === 'delivered' && e.replay)));
  assert.equal(noReplay.modes.async.status, 'unknown');
  assert.match(noReplay.modes.async.reason, /no restart between fetch and acknowledgement/);
});

test('wrong implementation: an echo before delivery, after acknowledgement, or in another conversation does not count', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  const echo = log.find(e => e.observation === 'model-echo');
  const without = log.filter(e => e !== echo);
  const gap = /no model-echo in a target conversation between delivery and acknowledgement/;
  const at = (index, event) => [...without.slice(0, index), event, ...without.slice(index)];
  const cases = {
    'before any delivery': at(without.findIndex(e => e.kind === 'delivered'), echo),
    'after acknowledgement': at(without.findIndex(e => e.kind === 'acknowledged') + 1, echo),
    'in another conversation': log.map(e => (e === echo ? { ...e, conversation: 'other-conversation' } : e)),
  };
  for (const [name, events] of Object.entries(cases)) {
    const result = verify(identity('desktop_extension'), events);
    assert.deepEqual(result.failures, [], name);
    assert.equal(result.modes.async.status, 'unknown', name);
    assert.match(result.modes.async.reason, gap, name);
  }
});

test('a replay counts only after a recorded before-ack restart on a connection opened after it', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  const isBeforeAck = e => e.observation === 'restart' && e.phase === 'before-ack';
  const gap = /missing evidence: .*no restart between fetch and acknowledgement/;
  const unrecorded = verify(identity('desktop_extension'), log.filter(e => !isBeforeAck(e)));
  assert.match(unrecorded.modes.async.reason, gap);
  // The same restart recorded only after the replay proves nothing.
  const replayAt = log.findIndex(e => e.kind === 'delivered' && e.replay);
  const late = log.filter(e => !isBeforeAck(e));
  late.splice(replayAt, 0, log.find(isBeforeAck));
  const result = verify(identity('desktop_extension'), late);
  assert.equal(result.modes.async.status, 'unknown');
  assert.match(result.modes.async.reason, gap);
});

test('the after-ack restart counts only when a later connection reads again', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  const restartAt = log.findIndex(e => e.observation === 'restart' && e.phase === 'after-ack');
  const result = verify(identity('desktop_extension'), log.slice(0, restartAt + 1));
  assert.equal(result.modes.async.status, 'unknown');
  assert.match(result.modes.async.reason, /after a restart that followed acknowledgement/);
});

test('operator observations cannot forge reserved event fields', async () => {
  const dir = await stateDir();
  await admin(dir, 'observe', 'census', 'kind=acknowledged', 'runId=forged', 'processes=1');
  const [event] = await events(dir);
  assert.equal(event.kind, 'observed');
  assert.equal(event.runId, 'test');
});

test('a lock left by a server killed mid-read is broken', async () => {
  const dir = await stateDir();
  await release(dir, 'after a crash');
  const lock = join(dir, 'lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const client = stdioClient(dir);
  try {
    await client.initialize();
    assert.match(await client.read(), /after a crash/);
  } finally {
    await client.close();
  }
});

test('notify probes are refused on the HTTP shapes', async () => {
  const dir = await stateDir('browser');
  await assert.rejects(admin(dir, 'notify', 'tools_list_changed'), /stdio desktop extension/);
});

test('a duplicate after acknowledgement or a reordered release fails the run', async () => {
  const dir = await stateDir();
  await fullAsyncRun(dir);
  const log = await events(dir);
  const delivered = log.find(e => e.kind === 'delivered');
  const duplicate = verify(identity('desktop_extension'), [...log, { ...delivered, replay: true }]);
  assert.ok(duplicate.failures.some(f => /delivered again/.test(f)));
  const two = [{ kind: 'arrived', releaseId: 'r_a' }, { kind: 'arrived', releaseId: 'r_b' },
    { kind: 'delivered', replay: false, releaseIds: ['r_b', 'r_a'], tokenId: 't' }];
  assert.ok(verify(identity('desktop_extension'), two).failures.some(f => /arrival order/.test(f)));
});

test('steer and sync become unsupported only on a recorded negative for that mode', async () => {
  const dir = await stateDir();
  await admin(dir, 'observe', 'negative', 'mode=sync', 'reason=no end-turn continuation primitive in this version');
  const result = await verdict(dir);
  assert.equal(result.modes.sync.status, 'unsupported');
  assert.equal(result.modes.sync.testedVersion, '0.0.0-test');
  assert.equal(result.modes.steer.status, 'unknown');
});

test('an incomplete identity tuple reports unknown for every mode', async () => {
  const negative = { kind: 'observed', observation: 'negative', mode: 'sync', reason: 'claimed absent' };
  const result = verify({ ...identity('desktop_extension'), appVersion: 'unknown' }, [negative]);
  assert.deepEqual(Object.values(result.modes).map(m => m.status), ['unknown', 'unknown', 'unknown']);
  assert.match(result.modes.async.reason, /appVersion/);
  assert.equal(result.acknowledgement, 'unknown');
});
