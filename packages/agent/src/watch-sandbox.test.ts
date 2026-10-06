import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { openSessionDir, writeJsonAtomic, writeStatus } from './state';
import { writeActivity, readActivity } from './activity';
import { appendEntries } from './inbox';
import { monitorArmed } from './watch';
import { monitorStorageCandidates } from './monitor-storage';
import { createMuseMonitorDriver } from './wake/muse-monitor';

const supported = process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0;
it.skipIf(!supported)('wakes through a read-only state bind with an invisible MCP PID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-readonly-watch-'));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: root };
  const sessionId = 'sandbox-readonly';
  const files = await openSessionDir('muse', sessionId, env);
  await writeJsonAtomic(files.session, { userId: '@self:local', roomId: '!room:local' });
  await writeStatus(files, 'connected');
  await writeActivity(files, 'idle');
  await appendEntries(files, [{ eventId: '$sandbox', roomId: '!room:local', ts: new Date().toISOString(),
    sender: '@peer:local', senderLabel: 'Peer', senderKind: 'human', kind: 'message', body: 'private channel body' }]);
  // The entire root is read-only except /tmp; bind this state fixture read-only
  // again so a temp HOME cannot accidentally make the reproduction writable.
  const bin = fileURLToPath(new URL('../bin/khala.mjs', import.meta.url));
  delete env.FORCE_COLOR;
  const child = spawn('bwrap', ['--ro-bind', '/', '/', '--bind', '/tmp', '/tmp',
    '--ro-bind', root, root, '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--',
    process.execPath, bin, 'watch', '--harness', 'muse', '--session', sessionId], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  try {
    await vi.waitFor(async () => {
      expect(child.exitCode, error).toBeNull();
      expect(await monitorArmed(files), error).toBe(true);
    }, { timeout: 8_000 });
    const line = 'Khala: channel messages are waiting. Continue. (k-deadbeef)';
    const activity = await readActivity(files);
    const driver = createMuseMonitorDriver();
    const context = { files, harness: 'muse', sessionId, env, signal: new AbortController().signal, now: Date.now() };
    await driver.wake(context, line);
    await vi.waitFor(() => expect(output, error).toBe(line + '\n'), { timeout: 5_000 });
    expect(await readActivity(files)).toEqual(activity);
    expect(output).not.toContain('private channel body');
    expect(error).toBe('');
    await writeStatus(files, 'disconnected', 'removed');
    await closed;
    expect(await monitorArmed(files)).toBe(false);
    expect(error).toContain('removed');
    expect(error).not.toMatch(/internal_error|watch_error/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await fs.rm(monitorStorageCandidates(files)[1]!, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
