import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectNativeGate, nativeProofBlock } from './native-gate';
import { interactiveCodexCapabilities } from '../../../packages/harnesses/src/codex/interactive';
import { decodeDeliveryLimits } from '../../../packages/contracts/src/delivery/index';
import { codexHooksFragment } from '../../../packages/agent-cli/src/codex/hooks-config';
import { codexPaths } from '../../../packages/agent-cli/src/setup/adapters/codex';
import { setupEnvironment } from '../../../packages/agent-cli/src/setup/environment';

describe('opt-in native acceptance gate', () => {
  it('requires an exact version-matched proven sync hook', () => {
    const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) throw new Error('test_limits_invalid');
    const limits = decoded.value;
    const hooks = interactiveCodexCapabilities('0.157.1', limits, { state: 'trusted' });
    assert.equal(nativeProofBlock('0.157.1', hooks), null);
    assert.equal(nativeProofBlock('0.157.0', hooks), 'native_version_unproven');
    assert.equal(nativeProofBlock('0.157.1', interactiveCodexCapabilities('0.154.0', limits,
      { state: 'trusted' })), 'native_hook_mode_unproven');
    assert.equal(nativeProofBlock('0.157.1', interactiveCodexCapabilities('0.157.1', limits,
      { state: 'unknown', reason: 'untrusted' })), 'native_hook_mode_unproven');
    assert.equal(nativeProofBlock('0.157.1', null), 'native_hook_mode_unproven');
  });
  it('reports not observed without a designated disposable session', async () => {
    assert.deepEqual(await inspectNativeGate(undefined), { kind: 'blocked', code: 'native_fixture_not_supplied' });
  });
  it('refuses invalid or non-disposable descriptors before probing a native tool', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-42-gate-'));
    try {
      const filename = path.join(directory, 'fixture.json');
      await writeFile(filename, JSON.stringify({
        v: 1, disposable: false, harness: 'codex', sessionId: '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856',
        workdir: directory, codexHome: path.join(directory, 'codex'),
      }));
      assert.deepEqual(await inspectNativeGate(filename), { kind: 'blocked', code: 'native_fixture_invalid' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses a version-and-hook-only Sol descriptor before any crash effects', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-42-sol-gate-'));
    const priorPath = process.env.PATH;
    const priorData = process.env.XDG_DATA_HOME;
    try {
      const bin = path.join(directory, 'bin');
      const codexHome = path.join(directory, 'codex-home');
      process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ''}`;
      process.env.XDG_DATA_HOME = path.join(directory, 'data');
      await mkdir(bin, { recursive: true });
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const executable = path.join(bin, 'codex');
      await writeFile(executable, '#!/bin/sh\nprintf "codex-cli 0.157.1\\n"\n');
      await chmod(executable, 0o700);
      const paths = codexPaths(setupEnvironment({ ...process.env, CODEX_HOME: codexHome }));
      await writeFile(paths.hooks, JSON.stringify(codexHooksFragment(paths.launcher)));
      const trust = ['pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'stop']
        .map(event => `[hooks.state.${JSON.stringify(`${paths.hooks}:${event}:0:0`)}]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`)
        .join('\n');
      await writeFile(paths.config, trust);
      const descriptor = path.join(directory, 'old-descriptor.json');
      const sessionId = '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856';
      await writeFile(descriptor, JSON.stringify({ v: 1, disposable: true, harness: 'codex',
        sessionId, workdir: directory, codexHome }), { mode: 0o600 });
      assert.deepEqual(await inspectNativeGate(descriptor),
        { kind: 'blocked', code: 'native_sol_handoff_unproven' });

      // A shaped v2 descriptor with matching private records still cannot turn
      // this unrelated live Node process into the exact native Sol TUI.
      const workdir = path.join(directory, 'workdir');
      const state = path.join(directory, 'state');
      const sessions = path.join(codexHome, 'sessions');
      await mkdir(workdir, { mode: 0o700 });
      await mkdir(state, { mode: 0o700 });
      await mkdir(sessions, { mode: 0o700 });
      const sessionFile = path.join(sessions, 'rollout-test.jsonl');
      await writeFile(sessionFile, [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workdir, cli_version: '0.157.1' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: workdir } }),
      ].join('\n') + '\n', { mode: 0o600 });
      await writeFile(path.join(state, 'scope.json'), JSON.stringify({ nativePid: process.pid,
        nativeStartTime: '1', nativeExecutable: executable, sessionFile, sessionId,
        cgroup: '/fake', codexHome, fixtureRoot: directory }), { mode: 0o600 });
      await writeFile(path.join(state, 'binding.json'), JSON.stringify({ v: 1, harness: 'codex',
        sessionId, bindingId: 'preflight-binding', generation: 0 }), { mode: 0o600 });
      const v2 = path.join(directory, 'crash-descriptor.json');
      await writeFile(v2, JSON.stringify({ v: 2, disposable: true, harness: 'codex',
        sessionId, workdir, codexHome, preflightRoot: directory, nativePid: process.pid,
        nativeStartTime: '1', preflightBindingId: 'preflight-binding', preflightGeneration: 0 }), { mode: 0o600 });
      assert.deepEqual(await inspectNativeGate(v2), { kind: 'blocked', code: 'native_sol_handoff_unproven' });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (priorData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorData;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
