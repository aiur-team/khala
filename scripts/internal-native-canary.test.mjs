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
  const read = row('khala_read', {}, '{"events":["challenge"]}');
  const send = row('khala_send', { message: 'reply challenge' }, '{"ok":true}');
  assert.deepEqual(modelEvidence([row('khala_read', {}, '{"events":[]}'), send], 'codex', 'challenge', 'reply'),
    { readCall: true, visible: false, sendCall: false });
  assert.deepEqual(modelEvidence([send, read], 'codex', 'challenge', 'reply'),
    { readCall: true, visible: true, sendCall: false });
  assert.deepEqual(modelEvidence([read, send], 'codex', 'challenge', 'reply'),
    { readCall: true, visible: true, sendCall: true });
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
});
