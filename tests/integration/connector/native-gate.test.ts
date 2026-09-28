import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectNativeGate, nativeProofBlock } from './native-gate';
import { interactiveCodexCapabilities } from '../../../packages/harnesses/src/codex/interactive';
import { decodeDeliveryLimits } from '../../../packages/contracts/src/delivery/index';

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
});
