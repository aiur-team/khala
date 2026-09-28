import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bindingFor, configAt, oldProcessGone } from './connector-control.mjs';

const script = fileURLToPath(new URL('./connector-control.mjs', import.meta.url));

test('lifecycle adapter rejects foreign units and non-owned descriptors before systemctl', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-44-control-'));
  const fragment = path.join(root, 'unit.service');
  writeFileSync(fragment, '[Unit]\n');
  const config = { v: 1, unit: 'other-user.service', harness: 'codex', sessionId: 'session_1',
    bindingId: 'binding_1', generation: 1, stateRoot: root, workdir: root,
    processExecutable: process.execPath, processCwd: root,
    processCgroup: '/user.slice/other-user.service', unitFragment: fragment };
  const file = path.join(root, 'control.json');
  try {
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    assert.throws(() => configAt(file), /live_connector_control_unavailable/u);
    assert.throws(() => execFileSync(process.execPath, [script, file, 'restart'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_000,
    }), /Command failed/u);
    writeFileSync(file, JSON.stringify({ ...config, unit: 'khala-e2e-connector-aabbccddeeff.service',
      processCgroup: '/user.slice/khala-e2e-connector-aabbccddeeff.service' }), { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.throws(() => configAt(file), /live_connector_control_unavailable/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('binding witness is tied to the exact provider session and generation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-44-control-'));
  const config = { harness: 'codex', sessionId: 'session_a', workdir: root,
    stateRoot: root, bindingId: 'binding_a', generation: 3 };
  const sessionHash = createHash('sha256').update(JSON.stringify([
    'khala.hosted.session.v1', config.harness, config.sessionId, config.workdir,
  ])).digest('hex');
  const directory = path.join(root, sessionHash);
  try {
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'current-binding.json'), JSON.stringify({
      bindingId: config.bindingId, generation: config.generation,
      harness: config.harness, sessionId: config.sessionId,
    }));
    assert.equal(bindingFor(config).bindingId, config.bindingId);
    assert.throws(() => bindingFor({ ...config, generation: 4 }), /live_connector_control_unavailable/u);
    assert.throws(() => bindingFor({ ...config, bindingId: 'foreign_binding' }), /live_connector_control_unavailable/u);
    assert.throws(() => bindingFor({ ...config, sessionId: 'session_b' }), /ENOENT/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live but foreign process cannot stand in for the disposable connector', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-44-control-'));
  const unit = 'khala-e2e-connector-aabbccddeeff.service';
  const fragment = path.join(root, unit);
  const fakeSystemctl = path.join(root, 'systemctl');
  const configPath = path.join(root, 'control.json');
  const workdir = realpathSync(process.cwd());
  const config = { v: 1, unit, harness: 'codex', sessionId: 'session_a', bindingId: 'binding_a',
    generation: 1, stateRoot: root, workdir, processExecutable: realpathSync(process.execPath),
    processCwd: workdir, processCgroup: `/user.slice/${unit}`, unitFragment: fragment };
  try {
    writeFileSync(fragment, '[Unit]\n');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf 'Id=${unit}\\nActiveState=active\\nMainPID=${process.pid}\\nControlGroup=${config.processCgroup}\\nFragmentPath=${fragment}\\n'\n`, { mode: 0o700 });
    assert.throws(() => execFileSync(process.execPath, [script, configPath, 'status'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
    }), /Command failed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restart witness accepts only proven old-process exit or PID reuse', () => {
  const before = { pid: 123, startTicks: '456' };
  assert.equal(oldProcessGone(before, () => '456'), false);
  assert.equal(oldProcessGone(before, () => '789'), true);
  for (const code of ['ENOENT', 'ESRCH']) {
    assert.equal(oldProcessGone(before, () => { throw Object.assign(new Error('gone'), { code }); }), true);
  }
  for (const code of ['EACCES', 'EIO']) {
    assert.throws(() => oldProcessGone(before, () => { throw Object.assign(new Error('unreadable'), { code }); }),
      error => error.code === code);
  }
  assert.throws(() => oldProcessGone(before, () => { throw new Error('malformed stat'); }), /malformed stat/u);
});
