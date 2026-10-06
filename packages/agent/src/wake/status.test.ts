import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { wakeStatusText, WAKE_STATES, CODEX_DAEMON_WAKE_NOTE, selectedWakeStatus } from './status';
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
    expect(rows.find(row => row.driver === 'queue')).toMatchObject({ state: 'active', reason: WAKE_STATES.active.reason, note: CODEX_DAEMON_WAKE_NOTE });
    expect(selectedWakeStatus(rows).note).toContain('even after the TUI exits');
    const { runWake } = await import('./cli');
    const output: string[] = [];
    for (const flags of [[], ['--json']]) {
      await runWake(['status', '--harness', 'codex', ...flags], { env: { PATH: root, XDG_STATE_HOME: root }, stdout: line => output.push(line) });
    }
    expect(output[0]).toContain(CODEX_DAEMON_WAKE_NOTE);
    expect(JSON.parse(output[1]!).find((row: { driver: string }) => row.driver === 'queue').note).toBe(CODEX_DAEMON_WAKE_NOTE);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('lists each runtime driver once without consent placeholders', async () => {
  const { wakeDrivers } = await import('./status');
  expect(wakeDrivers('claude').map(driver => driver.id)).toEqual(['watcher', 'terminal']);
  expect(wakeDrivers('codex').map(driver => driver.id)).toEqual(['queue', 'terminal']);
  for (const harness of ['claude', 'codex']) {
    expect(wakeDrivers(harness).find(driver => driver.id === 'terminal')?.runtime).toBeDefined();
  }
});

it('explains terminal guard failures instead of a generic remote-control message', () => {
  expect(wakeStatusText('terminal', 'unavailable', 'terminal_prompt_not_empty').reason).toContain('draft');
  expect(wakeStatusText('terminal', 'unavailable', 'terminal_pane_not_owned').reason).toContain('foreground process group');
  expect(wakeStatusText('terminal', 'unavailable', 'wezterm_tty_unavailable').reason).toContain('ownership cannot be verified');
});

it('reports Codex capture pending after terminal consent until its first prompt', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runWake } = await import('./cli');
  const { readWakeSettings } = await import('./shared');
  const { stateRoot, sessionFiles } = await import('../state');
  const { wakeStatus } = await import('./status');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-capture-pending-'));
  const env = { XDG_STATE_HOME: root, CODEX_THREAD_ID: 'session', TMUX: '/tmp/test,1,0', PATH: '' };
  try {
    expect(await runWake(['on', '--driver', 'terminal'], { env, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect((await readWakeSettings(stateRoot(env))).consent['codex/terminal']).toBeDefined();
    const rows = await wakeStatus('codex', { env, files: sessionFiles('codex', 'session', env) });
    const terminal = rows.filter(row => row.driver === 'terminal');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ state: 'unavailable', reason: WAKE_STATES.unavailable.reasons.terminal_capture_pending_prompt });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
