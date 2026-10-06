import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { wakeStatusText, WAKE_STATES } from './status';
it('renders every state from one fixed reason and remedy table', () => {
  for (const state of Object.keys(WAKE_STATES) as (keyof typeof WAKE_STATES)[]) {
    const result = wakeStatusText('terminal', state);
    expect(result.reason).toBe(WAKE_STATES[state].reason);
    if (state === 'needs_consent' || state === 'disabled_after_failures') expect(result.remedy).toBe('khala wake on --driver terminal');
  }
});

it('reports Claude expiry from the U12 watcher file', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { sessionFiles } = await import('../state');
  const { wakeStatus } = await import('./status');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-status-'));
  const env = { XDG_STATE_HOME: root };
  const files = sessionFiles('claude', 'session', env);
  try {
    await fs.mkdir(files.dir, { recursive: true });
    for (const [state, expected] of [['armed', 'active'], ['expired', 'lapsed'], ['exited', 'unavailable']] as const) {
      await fs.writeFile(path.join(files.dir, 'watcher.json'), JSON.stringify({ state, pid: process.pid }));
      expect((await wakeStatus('claude', { env, files }))[0]!.state).toBe(expected);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('requires a live valid PID for an armed Claude watcher', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { sessionFiles } = await import('../state');
  const { wakeStatus } = await import('./status');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-status-pid-'));
  const env = { XDG_STATE_HOME: root };
  const files = sessionFiles('claude', 'session', env);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  await once(child, 'exit');
  expect(deadPid).toBeGreaterThan(0);
  try {
    await fs.mkdir(files.dir, { recursive: true });
    for (const pid of [deadPid, undefined, null, '123', -1, 0, 1.5]) {
      await fs.writeFile(path.join(files.dir, 'watcher.json'), JSON.stringify({ state: 'armed', pid }));
      expect((await wakeStatus('claude', { env, files }))[0]).toMatchObject({ state: 'unavailable', reason: WAKE_STATES.unavailable.reasons.watcher_missing });
    }
    await fs.writeFile(path.join(files.dir, 'watcher.json'), JSON.stringify({ state: 'armed', pid: process.pid }));
    expect((await wakeStatus('claude', { env, files }))[0]!.state).toBe('active');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); });
    try { expect((await wakeStatus('claude', { env, files }))[0]!.state).toBe('active'); }
    finally { kill.mockRestore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('reports a missing Codex queue instead of active', async () => {
  const { wakeStatus } = await import('./status');
  const rows = await wakeStatus('codex', { env: { PATH: '', XDG_STATE_HOME: '/nonexistent-khala-u1133-status' } });
  expect(rows.find(row => row.driver === 'queue')).toMatchObject({ state: 'unavailable', reason: 'Codex queue is missing.' });
});

it.skipIf(process.platform === 'win32')('probes only queue help and reports an available native driver', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { wakeStatus } = await import('./status');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-queue-probe-'));
  try {
    await fs.writeFile(path.join(root, 'codex'), '#!/bin/sh\n[ "$1" = queue ] && [ "$2" = --help ] || exit 1\nprintf "%s\\n" "--thread --message\\n"\n', { mode: 0o700 });
    const rows = await wakeStatus('codex', { env: { PATH: root, XDG_STATE_HOME: root } });
    expect(rows.find(row => row.driver === 'queue')).toMatchObject({ state: 'active', reason: WAKE_STATES.active.reason });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
