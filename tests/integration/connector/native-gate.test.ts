import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectNativeGate } from './native-gate';

describe('opt-in native acceptance gate', () => {
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
