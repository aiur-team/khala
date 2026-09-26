// One live run per repository on the host: a kernel-held lock keyed by the
// repository alone, released by process death, with no TTL takeover.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hostLock } from '../../../scripts/acceptance/lock';
import { runAcceptance } from '../../../scripts/acceptance/runner';
import { RUN_ID, createWorld, offlineProfile } from './fakes';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HOLDER = fileURLToPath(new URL('./fixtures/hold-lock.ts', import.meta.url));
const REPOSITORY = 'aiur-team/khala';

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function stateHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-lock-'));
  directories.push(directory);
  return directory;
}

/** Another runner process on the same host holding the lock. */
async function holder(home: string, repository: string): Promise<ChildProcess> {
  // One process: the tsx loader runs in-process, so killing it kills the lock holder itself.
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=khala-source', HOLDER, home, repository], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', chunk => { out += String(chunk); if (out.includes('\n')) resolve(out.trim()); });
    child.once('exit', code => reject(new Error(`holder exited ${code}`)));
  });
  expect(line).toBe('held');
  return child;
}

describe('host acceptance lock', () => {
  it('lets a different profile on the same repository contend for, and lose, the one lock', async () => {
    const home = stateHome();
    await holder(home, REPOSITORY);
    expect(await hostLock(home).acquire(REPOSITORY)).toBeNull();

    const world = createWorld({}, offlineProfile({ name: 'another-profile' }));
    const report = await runAcceptance({ ...world.deps, lock: hostLock(home) }, { profile: world.profile, runId: RUN_ID, resume: null });
    expect(report.verdict).toBe('refused');
    expect(world.issues.size).toBe(0);
    expect(world.launcherStarts).toBe(0);
  }, 30_000);

  it('does not serialize different repositories', async () => {
    const home = stateHome();
    await holder(home, REPOSITORY);
    const other = await hostLock(home).acquire('aiur-team/other');
    expect(other).not.toBeNull();
    await other!.release();
  }, 30_000);

  it('is released when the holding process dies, with no timeout', async () => {
    const home = stateHome();
    const child = await holder(home, REPOSITORY);
    expect(await hostLock(home).acquire(REPOSITORY)).toBeNull();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const lock = await hostLock(home).acquire(REPOSITORY);
    expect(lock).not.toBeNull();
    await lock!.release();
  }, 30_000);
});
