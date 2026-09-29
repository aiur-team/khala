import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('protected-base deletion status checks real Git histories and failure states', () => {
  const result = spawnSync('bash', ['scripts/test-trusted-pr-deletion-gate.sh'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /same-repo, fork, stale-base and status outcomes/u);
});
