import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { modelEvidence } from './internal-native-model-evidence.mjs';

const script = path.resolve('scripts/internal-native-canary.mjs');

test('native canary refuses an unproven session before opening a room', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-native-preflight-'));
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ id: 'test', home: path.join(directory, 'home'), socket: path.join(directory, 'tmux.sock') }), { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, 'open', directory], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, kind: 'unproven', stage: 'session_arguments', directory });
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'run.json'), 'utf8')).channelId, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex evidence requires challenge in completed read result before send', () => {
  const row = (tool, args, result) => ({ type: 'response_item', payload: { type: 'mcp_tool_call', tool, arguments: args, result } });
  const read = row('khala_read', {}, '{"events":["challenge"],"batchToken":"token-1"}');
  const send = row('khala_send', { message: 'reply challenge', ackBatchToken: 'token-1' }, '{"ok":true}');
  assert.deepEqual(modelEvidence([row('khala_read', {}, '{"events":[]}'), send], 'codex', 'challenge', 'reply'),
    { readCall: true, visible: false, sendCall: false });
  assert.deepEqual(modelEvidence([send, read], 'codex', 'challenge', 'reply'),
    { readCall: true, visible: true, sendCall: false });
  assert.deepEqual(modelEvidence([read, send], 'codex', 'challenge', 'reply'),
    { readCall: true, visible: true, sendCall: true });
  assert.deepEqual(modelEvidence([read, row('khala_send', { message: 'reply', ackBatchToken: 'wrong' }, '{"ok":true}')],
    'codex', 'challenge', 'reply'), { readCall: true, visible: true, sendCall: false });
});

test('Claude evidence correlates read result by tool_use_id before send', () => {
  const call = (id, name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const read = call('read-1', 'khala_read');
  const send = call('send-1', 'khala_send', { message: 'reply' });
  assert.deepEqual(modelEvidence([read, result('unrelated', 'challenge'), send], 'claude', 'challenge', 'reply'),
    { readCall: true, visible: false, sendCall: false });
  assert.deepEqual(modelEvidence([read, result('read-1', 'challenge'), send], 'claude', 'challenge', 'reply'),
    { readCall: true, visible: true, sendCall: true });
  assert.deepEqual(modelEvidence([send, read, result('read-1', 'challenge')], 'claude', 'challenge', 'reply'),
    { readCall: true, visible: true, sendCall: false });
});

test('quoted challenge is visible only in the matching native read result', () => {
  const challenge = 'Codex send exactly "18 nonce codex"; Claude send exactly "18 nonce claude".';
  const codexRow = (tool, args, result) => ({ type: 'response_item', payload: { type: 'mcp_tool_call', tool, arguments: args, result } });
  const read = codexRow('khala_read', {}, { content: [{ type: 'text', text: JSON.stringify({ events: [{ body: challenge }], batchToken: 'token-3' }) }] });
  const send = codexRow('khala_send', { message: '18 nonce codex', ackBatchToken: 'token-3' }, { ok: true });
  assert.deepEqual(modelEvidence([read, send], 'codex', challenge, '18 nonce codex'),
    { readCall: true, visible: true, sendCall: true });
  assert.deepEqual(modelEvidence([codexRow('khala_read', {}, { events: [] }),
    codexRow('khala_send', { message: challenge }, { ok: true })], 'codex', challenge, challenge),
  { readCall: true, visible: false, sendCall: false });
});

test('external cleanup refuses a live recorded PTY process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-native-external-'));
  fs.chmodSync(directory, 0o700);
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/);
  fs.writeFileSync(path.join(directory, 'codex-pty.pid'), `${process.pid} ${stat[19]} ${fs.readlinkSync('/proc/self/ns/pid')}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ id: 'test', ptyMode: 'external' }), { mode: 0o600 });
  try {
    for (const action of ['stop', 'destroy']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', script, action, directory], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), { ok: false, kind: 'unproven', stage: 'external_agents_running', directory });
      assert.equal(fs.existsSync(directory), true);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('external cleanup refuses a process in another PID namespace', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-native-external-'));
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, 'codex-pty.pid'), '2 123 pid:[999999999]\n', { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ id: 'test', ptyMode: 'external' }), { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, 'destroy', directory], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, kind: 'unproven', stage: 'external_process_unobservable', directory });
    assert.equal(fs.existsSync(directory), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
