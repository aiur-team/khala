// Private Executor fixture capture: scope, complete observation, and process
// identity must all agree. Agent prose and daemon logs are irrelevant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { aiurRecords, captureNativeSession, decodeNativeSession, observeProcess, type ProcessSnapshot } from '../../../scripts/acceptance/adapters/aiur';

const OBSERVATION = {
  source: 'executor-native-tmux-fixture', repository: 'aiur-team/khala', runId: '0123456789ab',
  ticket: 1001, role: 'a', sessionId: '01a0e073-8cbc-7d50-9375-f71092d876f0', pid: 4242,
  harness: 'codex', provider: 'openai', model: 'gpt-6-sol', cliVersion: '0.156.1',
  versionOutput: 'codex-cli 0.156.1',
  startedAt: '2026-09-26T10:00:00Z', capturedAt: '2026-09-26T10:01:00Z', processStartTicks: '123456', bootId: 'boot-7',
  executable: '/usr/bin/node', argv: ['codex', '--model', 'gpt-6-sol'], tty: '/dev/pts/7', tmuxPane: '%7',
};
const PROCESS: ProcessSnapshot = {
  pid: 4242, processStartTicks: '123456', bootId: 'boot-7', executable: '/usr/bin/node',
  argv: ['codex', '--model', 'gpt-6-sol'], tty: '/dev/pts/7',
};
const STATUS = '│  Model: GPT-6-Sol (reasoning medium) │\n│  Model provider: openai │\n│  Session: 01a0e073-8cbc-7d50-9375-f71092d876f0 │';
const status = () => STATUS;
const version = () => 'codex-cli 0.156.1\n';
const roots: string[] = [];
function root() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-native-')); roots.push(directory); return directory; }
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Executor native fixture evidence', () => {
  it('captures one private scoped native process and reads only its exact run, ticket, and role', async () => {
    const directory = root();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true, undefined, status, version);
    const port = aiurRecords(directory, 'aiur-team/khala', () => PROCESS, () => true, status, version);
    expect((await port.session(1001, OBSERVATION.runId, 'a'))?.sessionId).toBe(OBSERVATION.sessionId);
    expect(await port.session(1002, OBSERVATION.runId, 'a')).toBeNull();
    expect(await port.session(1001, 'ffffffffffff', 'a')).toBeNull();
    expect(await port.session(1001, OBSERVATION.runId, 'b')).toBeNull();
    expect(await aiurRecords(directory, 'foreign/repo', () => PROCESS, () => true).session(1001, OBSERVATION.runId, 'a')).toBeNull();
    expect(await port.alive(decodeNativeSession(OBSERVATION)!)).toBe(true);
    const recordFile = path.join(directory, Buffer.from('aiur-team/khala').toString('base64url'), OBSERVATION.runId, '1001-a.json');
    expect(fs.statSync(recordFile).mode & 0o077).toBe(0);
    const oldRecord = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    delete oldRecord.nativeIdentityProof;
    fs.writeFileSync(recordFile, JSON.stringify(oldRecord));
    expect(await port.session(1001, OBSERVATION.runId, 'a')).toBeNull();
  });

  it('rejects partial, claimed-only, app-server, and mismatched process observations', () => {
    const directory = root();
    expect(decodeNativeSession({ ...OBSERVATION, model: undefined })).toBeNull();
    expect(decodeNativeSession({ ...OBSERVATION, source: 'worker-prose' })).toBeNull();
    expect(decodeNativeSession({ ...OBSERVATION, argv: ['codex', 'app-server'] })).toBeNull();
    expect(() => captureNativeSession(directory, OBSERVATION, () => ({ ...PROCESS, processStartTicks: '999999' }), () => true, undefined, status, version)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => ({ ...PROCESS, argv: ['codex', 'app-server'] }), () => true, undefined, status, version)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => null, () => true, undefined, status, version)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => PROCESS, () => false, undefined, status, version)).toThrow(/tmux pane/);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, argv: ['node', 'other.js', 'codex', '--model', 'gpt-6-sol'] },
      () => ({ ...PROCESS, argv: ['node', 'other.js', 'codex', '--model', 'gpt-6-sol'] }), () => true, undefined, status, version)).toThrow(/native harness/);
  });

  it('refuses a second participant for one ticket and PID reuse or death', async () => {
    const directory = root();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true, undefined, status, version);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, sessionId: 'native-8' }, () => PROCESS, () => true, undefined, status, version)).toThrow();
    const reused = aiurRecords(directory, 'aiur-team/khala', () => ({ ...PROCESS, processStartTicks: '999999' }), () => true, status, version);
    expect(await reused.session(1001, OBSERVATION.runId, 'a')).toBeNull();
    expect(await reused.alive(decodeNativeSession(OBSERVATION)!)).toBe(false);
    expect(await aiurRecords(directory, 'aiur-team/khala', () => null, () => true, status, version).session(1001, OBSERVATION.runId, 'a')).toBeNull();
  });

  it('refuses a live process that has switched native session, model, or image after capture', async () => {
    const directory = root();
    let shown: string | null = STATUS;
    let image: string | null = version();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true, undefined, () => shown, () => image);
    const port = aiurRecords(directory, OBSERVATION.repository, () => PROCESS, () => true, () => shown, () => image);
    const captured = decodeNativeSession(OBSERVATION)!;
    expect(await port.session(OBSERVATION.ticket, OBSERVATION.runId, 'a')).not.toBeNull();
    expect(await port.alive(captured)).toBe(true);
    for (const changed of [
      STATUS.replace(OBSERVATION.sessionId, '00000000-0000-4000-8000-000000000001'),
      STATUS.replace('GPT-6-Sol', 'different-model'),
      null,
    ]) {
      shown = changed;
      expect(await port.session(OBSERVATION.ticket, OBSERVATION.runId, 'a')).toBeNull();
      expect(await port.alive(captured)).toBe(false);
    }
    shown = STATUS;
    image = 'codex-cli 0.157.1\n';
    expect(await port.session(OBSERVATION.ticket, OBSERVATION.runId, 'a')).toBeNull();
    expect(await port.alive(captured)).toBe(false);
  });

  it('refuses tampered model or CLI version against the native process command and expected profile', () => {
    const directory = root();
    expect(() => captureNativeSession(directory, { ...OBSERVATION, model: 'wrong-model' }, () => PROCESS, () => true, undefined, status, version)).toThrow();
    expect(decodeNativeSession({ ...OBSERVATION, cliVersion: '' })).toBeNull();
    expect(() => captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true,
      undefined, status, () => 'prefix codex-cli 0.156.1')).toThrow(/CLI version is unproven/);
  });

  it('binds a Claude status UUID, account, and model to the exact running image version', async () => {
    const directory = root();
    const executable = '/opt/claude/versions/2.1.283';
    const argv = [executable, '--model', 'claude-opus-5-5'];
    const native = { ...OBSERVATION, harness: 'claude', provider: 'anthropic', model: 'claude-opus-5-5',
      cliVersion: '2.1.283', versionOutput: '2.1.283 (Claude Code)', executable, argv };
    const process = { ...PROCESS, executable, argv };
    const screen = `Session ID:        ${native.sessionId}\nSession kind:      interactive\nLogin method:      Claude Max account\nModel:             opus (claude-opus-5-5)\n`;
    const capture = (value: typeof native, shown = screen, image = '2.1.283 (Claude Code)\n') =>
      captureNativeSession(directory, value, () => process, () => true, undefined, () => shown, () => image);
    const captured = capture(native);
    expect(captured.sessionId).toBe(native.sessionId);
    let shown: string | null = screen;
    const held = aiurRecords(directory, native.repository, () => process, () => true,
      () => shown, () => '2.1.283 (Claude Code)\n');
    expect((await held.session(native.ticket, native.runId, 'a'))?.harness).toBe('claude');
    shown = screen.replace(native.sessionId, '00000000-0000-4000-8000-000000000001');
    expect(await held.session(native.ticket, native.runId, 'a')).toBeNull();
    expect(await held.alive(captured)).toBe(false);
    shown = screen.replace('claude-opus-5-5', 'claude-other-model');
    expect(await held.session(native.ticket, native.runId, 'a')).toBeNull();
    expect(await held.alive(captured)).toBe(false);
    const altered = root();
    const check = (value: typeof native, shown = screen, image = '2.1.283 (Claude Code)\n') =>
      captureNativeSession(altered, value, () => process, () => true, undefined, () => shown, () => image);
    expect(() => check({ ...native, sessionId: '00000000-0000-4000-8000-000000000001' })).toThrow(/session ID is unproven/);
    expect(() => check(native, screen.replace('Claude Max account', 'unknown account'))).toThrow(/session ID is unproven/);
    expect(() => check(native, screen.replace('claude-opus-5-5', 'claude-other-model'))).toThrow(/session ID is unproven/);
    expect(() => check(native, screen, '2.1.284 (Claude Code)\n')).toThrow(/CLI version is unproven/);
  });

  it('rejects a substituted driver ID even with genuine process, pane, and model evidence', () => {
    const directory = root();
    const driverId = '01a0e073-0000-7000-8000-000000000001';
    expect(() => captureNativeSession(directory, { ...OBSERVATION, sessionId: driverId },
      () => PROCESS, () => true, undefined, status, version)).toThrow(/session ID is unproven/);
    expect(() => captureNativeSession(directory, OBSERVATION,
      () => PROCESS, () => true, undefined, () => null, version)).toThrow(/session ID is unproven/);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, harness: 'claude', provider: 'anthropic', argv: ['claude', '--model', 'gpt-6-sol'] },
      () => ({ ...PROCESS, argv: ['claude', '--model', 'gpt-6-sol'] }), () => true)).toThrow();
  });

  it.skipIf(process.platform !== 'linux' || !fs.existsSync('/usr/bin/script'))(
    'rejects a driver ID substituted for a genuine unrelated PTY process', async () => {
      const directory = root();
      const fixture = path.join(directory, 'codex.js');
      const pidFile = path.join(directory, 'pid');
      fs.writeFileSync(fixture, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
      const pty = spawn('/usr/bin/script', ['-q', '-e', '-c',
        `${process.execPath} ${fixture} ${pidFile} --model gpt-6-sol`, '/dev/null'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      pty.stdout.on('data', chunk => { output += String(chunk); });
      pty.stderr.on('data', chunk => { output += String(chunk); });
      let pid = 0;
      try {
        for (let attempt = 0; attempt < 50 && !pid; attempt++) {
          if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
          else await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(pid, `PTY child did not start; script exit ${pty.exitCode}: ${output}`).toBeGreaterThan(1);
        const live = observeProcess(pid);
        expect(live, `PTY child ${pid} was not observable`).not.toBeNull();
        expect(live?.tty).toMatch(/^\/dev\/pts\/\d+$/);
        const observation = {
          ...OBSERVATION, pid, executable: live!.executable, argv: live!.argv,
          processStartTicks: live!.processStartTicks, bootId: live!.bootId, tty: live!.tty,
          sessionId: '01a0e073-0000-7000-8000-000000000001',
        };
        expect(() => captureNativeSession(directory, observation, observeProcess, () => true,
          undefined, status, version)).toThrow(/session ID is unproven/);
        expect(captureNativeSession(directory, { ...observation, sessionId: OBSERVATION.sessionId },
          observeProcess, () => true, undefined, status, version).sessionId).toBe(OBSERVATION.sessionId);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
        pty.kill('SIGTERM');
      }
    },
  );

  it.skipIf(process.platform !== 'linux' || !fs.existsSync('/usr/bin/tmux') || !fs.existsSync('/usr/bin/cc'))(
    'reads a live native image and pane, rejecting forged ID and version', async () => {
      const directory = root();
      // Unix socket paths cap at 108 bytes; the workspace-local scratch root is shorter than TMPDIR.
      const socket = path.join(process.cwd(), `.aiur239-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
      const fixture = path.join(directory, 'codex');
      const source = path.join(directory, 'codex.c');
      fs.writeFileSync(source, `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) { if (argc == 2 && strcmp(argv[1], "--version") == 0) { puts("codex-cli 0.156.1"); return 0; } fputs(${JSON.stringify(`${STATUS}\n`)}, stdout); fflush(stdout); for (;;) sleep(1); }`);
      execFileSync('/usr/bin/cc', [source, '-o', fixture]);
      const tmux = (...args: string[]) => execFileSync('/usr/bin/tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
      const previousTmux = process.env.TMUX;
      try {
        tmux('new-session', '-d', '-s', 'native', `${fixture} --model gpt-6-sol`);
        process.env.TMUX = `${socket},0,0`;
        const pane = tmux('list-panes', '-t', 'native', '-F', '#{pane_id}');
        const pid = Number(tmux('list-panes', '-t', 'native', '-F', '#{pane_pid}'));
        let live: ProcessSnapshot | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          live = observeProcess(pid);
          if (live?.executable === fixture && tmux('capture-pane', '-p', '-t', pane).includes(OBSERVATION.sessionId)) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(live?.executable).toBe(fixture);
        const observation = {
          ...OBSERVATION, pid, tmuxPane: pane, executable: live!.executable, argv: live!.argv,
          processStartTicks: live!.processStartTicks, bootId: live!.bootId, tty: live!.tty,
        };
        expect(() => captureNativeSession(directory, { ...observation, sessionId: '01a0e073-0000-7000-8000-000000000001' }))
          .toThrow(/session ID is unproven/);
        expect(() => captureNativeSession(directory, { ...observation, cliVersion: '0.157.1', versionOutput: 'codex-cli 0.157.1' }))
          .toThrow(/CLI version is unproven/);
        expect(captureNativeSession(directory, observation).sessionId).toBe(OBSERVATION.sessionId);
        expect(observeProcess(pid)?.processStartTicks).toBe(live!.processStartTicks);
      } finally {
        if (previousTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = previousTmux;
        try { tmux('kill-server'); } catch { /* fixture may already have exited */ }
      }
    },
  );

  it.skipIf(process.platform !== 'linux' || !fs.existsSync('/usr/bin/tmux') || !fs.existsSync('/usr/bin/cc'))(
    'joins an OpenCode pane title to one native read-only session and assistant model', async () => {
      const directory = root();
      const socket = path.join(process.cwd(), `.aiur239-opencode-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
      const fixture = path.join(directory, 'opencode');
      const source = path.join(directory, 'opencode.c');
      const dataHome = path.join(directory, 'data');
      const dbPath = path.join(dataHome, 'opencode', 'opencode.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const sessionId = 'ses_1234567890abcdef';
      const title = 'Native fixture session';
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE session (id TEXT, title TEXT, directory TEXT, version TEXT, model TEXT); CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)');
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(sessionId, title, directory, '1.17.10',
        JSON.stringify({ providerID: 'deepseek', id: 'deepseek-flash' }));
      db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(sessionId, 1,
        JSON.stringify({ role: 'assistant', providerID: 'deepseek', modelID: 'deepseek-flash' }));
      db.close();
      fs.writeFileSync(source, `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) { if (argc == 2 && strcmp(argv[1], "--version") == 0) { puts("1.17.10"); return 0; } fputs("\\033]2;OC | Native fixture session\\007\\nBuild · DeepSeek V4.1 Flash DeepSeek\\n", stdout); fflush(stdout); for (;;) sleep(1); }`);
      execFileSync('/usr/bin/cc', [source, '-o', fixture]);
      const tmux = (...args: string[]) => execFileSync('/usr/bin/tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim();
      const previousTmux = process.env.TMUX;
      try {
        tmux('new-session', '-d', '-s', 'native', '-c', directory,
          `env XDG_DATA_HOME=${dataHome} ${fixture} --model deepseek/deepseek-flash`);
        process.env.TMUX = `${socket},0,0`;
        const pane = tmux('list-panes', '-t', 'native', '-F', '#{pane_id}');
        const pid = Number(tmux('list-panes', '-t', 'native', '-F', '#{pane_pid}'));
        let live: ProcessSnapshot | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          live = observeProcess(pid);
          if (live?.executable === fixture && tmux('display-message', '-p', '-t', pane, '#{pane_title}') === `OC | ${title}`) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(live?.executable).toBe(fixture);
        const observation = { ...OBSERVATION, harness: 'opencode', provider: 'deepseek', model: 'deepseek/deepseek-flash',
          sessionId, cliVersion: '1.17.10', versionOutput: '1.17.10', pid, tmuxPane: pane,
          executable: live!.executable, argv: live!.argv, processStartTicks: live!.processStartTicks,
          bootId: live!.bootId, tty: live!.tty };
        expect(() => captureNativeSession(path.join(directory, 'bad-id'), { ...observation, sessionId: 'ses_forged1234567890' }))
          .toThrow(/session ID is unproven/);
        expect(() => captureNativeSession(path.join(directory, 'bad-version'), { ...observation,
          cliVersion: '1.17.11', versionOutput: '1.17.11' }))
          .toThrow(/CLI version is unproven/);
        const captured = captureNativeSession(path.join(directory, 'records'), observation);
        expect(captured.sessionId).toBe(sessionId);
        const held = aiurRecords(path.join(directory, 'records'), observation.repository);
        expect((await held.session(observation.ticket, observation.runId, 'a'))?.sessionId).toBe(sessionId);
        expect(await held.alive(captured)).toBe(true);
        const selected = JSON.stringify({ providerID: 'deepseek', id: 'deepseek-flash' });
        const chosenProviderMismatch = new DatabaseSync(dbPath);
        chosenProviderMismatch.prepare('UPDATE session SET model = ?').run(JSON.stringify({ providerID: 'anthropic', id: 'deepseek-flash' }));
        chosenProviderMismatch.close();
        expect(() => captureNativeSession(path.join(directory, 'bad-chosen-provider'), observation))
          .toThrow(/session ID is unproven/);
        expect(await held.session(observation.ticket, observation.runId, 'a')).toBeNull();
        expect(await held.alive(captured)).toBe(false);
        const restoreSelection = new DatabaseSync(dbPath);
        restoreSelection.prepare('UPDATE session SET model = ?').run(selected);
        restoreSelection.close();
        expect(await held.alive(captured)).toBe(true);
        const changed = new DatabaseSync(dbPath);
        changed.prepare('UPDATE message SET data = ?').run(JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'deepseek-flash' }));
        changed.close();
        expect(() => captureNativeSession(path.join(directory, 'bad-model'), observation))
          .toThrow(/session ID is unproven/);
        expect(await held.session(observation.ticket, observation.runId, 'a')).toBeNull();
        expect(await held.alive(captured)).toBe(false);
        const deleted = new DatabaseSync(dbPath);
        deleted.prepare('UPDATE message SET data = ?').run(JSON.stringify({ role: 'assistant', providerID: 'deepseek', modelID: 'deepseek-flash' }));
        deleted.prepare('DELETE FROM session WHERE id = ?').run(sessionId);
        deleted.close();
        expect(await held.session(observation.ticket, observation.runId, 'a')).toBeNull();
        expect(await held.alive(captured)).toBe(false);
        expect(observeProcess(pid)?.processStartTicks).toBe(live!.processStartTicks);
      } finally {
        if (previousTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = previousTmux;
        try { tmux('kill-server'); } catch { /* fixture may already have exited */ }
      }
    },
  );
});
