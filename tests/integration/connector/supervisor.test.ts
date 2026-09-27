import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { killAtNativeAcceptance } from './supervisor';

describe('native crash supervisor mechanics (not live acceptance)', () => {
  const child = fileURLToPath(new URL('./fixtures/accepted-child.mjs', import.meta.url));
  it('reaps a child with SIGKILL only after matching metadata', async () => {
    const observation = await killAtNativeAcceptance({
      command: process.execPath, args: [child], cwd: process.cwd(), env: process.env,
      expectedReleaseId: 'release-test', expectedSessionId: 'session-test',
    });
    assert.equal(observation.accepted.releaseId, 'release-test');
    assert.equal(observation.accepted.sessionId, 'session-test');
    assert.equal(observation.signal, 'SIGKILL');
  });
  it('rejects a mismatched native identity', async () => {
    await assert.rejects(killAtNativeAcceptance({
      command: process.execPath, args: [child], cwd: process.cwd(), env: process.env,
      expectedReleaseId: 'other-release', expectedSessionId: 'session-test',
    }), /native_acceptance_identity_mismatch/u);
  });

  it('rejects a matching release from the wrong native session', async () => {
    await assert.rejects(killAtNativeAcceptance({
      command: process.execPath, args: [child], cwd: process.cwd(), env: process.env,
      expectedReleaseId: 'release-test', expectedSessionId: 'other-session',
    }), /native_acceptance_identity_mismatch/u);
  });
});
