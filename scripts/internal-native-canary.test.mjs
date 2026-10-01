import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
