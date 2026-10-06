import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { channelFiles, ensureStateDir, openSessionDir, stateRoot, writeStateFile } from '../state';
import { codexStartupSessions } from './startup-sessions';

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-startup-discovery-'));
  env = { XDG_STATE_HOME: root, PWD: process.cwd() };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('does not create state when no saved Codex sessions exist', async () => {
  expect(await codexStartupSessions(env)).toEqual([]);
  expect(await fs.readdir(root)).toEqual([]);
});
it('ignores files and symlinked session directories without reading their authorizations', async () => {
  const files = await openSessionDir('codex', 'saved', env);
  const nested = channelFiles(files, '!room:local');
  await ensureStateDir(nested.dir);
  await writeStateFile(nested.dir, 'channel.json', { roomId: '!room:local' });
  await writeStateFile(nested.dir, 'resume.json', { workspace: process.cwd() });
  await fs.symlink(files.dir, path.join(stateRoot(env), 'codex', 'alias'), 'dir');
  await fs.writeFile(path.join(stateRoot(env), 'codex', 'not-a-directory'), '{}');
  expect(await codexStartupSessions(env)).toEqual([{ sessionId: 'saved', rejoinable: true }]);
});
it.skipIf(process.platform === 'win32')('rejects unsafe root or harness permissions', async () => {
  await openSessionDir('codex', 'saved', env);
  for (const dir of [stateRoot(env), path.join(stateRoot(env), 'codex')]) {
    await fs.chmod(dir, 0o755);
    await expect(codexStartupSessions(env)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
    await fs.chmod(dir, 0o700);
  }
});
