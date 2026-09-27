// Private Executor fixture capture: scope, complete observation, and process
// identity must all agree. Agent prose and daemon logs are irrelevant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
const roots: string[] = [];
function root() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-native-')); roots.push(directory); return directory; }
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Executor native fixture evidence', () => {
  it('captures one private scoped native process and reads only its exact run, ticket, and role', async () => {
    const directory = root();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true, undefined, status);
    const port = aiurRecords(directory, 'aiur-team/khala', () => PROCESS, () => true);
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
    expect(() => captureNativeSession(directory, OBSERVATION, () => ({ ...PROCESS, processStartTicks: '999999' }), () => true, undefined, status)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => ({ ...PROCESS, argv: ['codex', 'app-server'] }), () => true, undefined, status)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => null, () => true, undefined, status)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => PROCESS, () => false, undefined, status)).toThrow(/tmux pane/);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, argv: ['node', 'other.js', 'codex', '--model', 'gpt-6-sol'] },
      () => ({ ...PROCESS, argv: ['node', 'other.js', 'codex', '--model', 'gpt-6-sol'] }), () => true, undefined, status)).toThrow(/native harness/);
  });

  it('refuses a second participant for one ticket and PID reuse or death', async () => {
    const directory = root();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true, undefined, status);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, sessionId: 'native-8' }, () => PROCESS, () => true, undefined, status)).toThrow();
    const reused = aiurRecords(directory, 'aiur-team/khala', () => ({ ...PROCESS, processStartTicks: '999999' }), () => true);
    expect(await reused.session(1001, OBSERVATION.runId, 'a')).toBeNull();
    expect(await reused.alive(decodeNativeSession(OBSERVATION)!)).toBe(false);
    expect(await aiurRecords(directory, 'aiur-team/khala', () => null, () => true).session(1001, OBSERVATION.runId, 'a')).toBeNull();
  });

  it('refuses tampered model or CLI version against the native process command and expected profile', () => {
    const directory = root();
    expect(() => captureNativeSession(directory, { ...OBSERVATION, model: 'wrong-model' }, () => PROCESS, () => true, undefined, status)).toThrow();
    expect(decodeNativeSession({ ...OBSERVATION, cliVersion: '' })).toBeNull();
  });

  it('rejects a substituted driver ID even with genuine process, pane, and model evidence', () => {
    const directory = root();
    const driverId = '01a0e073-0000-7000-8000-000000000001';
    expect(() => captureNativeSession(directory, { ...OBSERVATION, sessionId: driverId },
      () => PROCESS, () => true, undefined, status)).toThrow(/session ID is unproven/);
    expect(() => captureNativeSession(directory, OBSERVATION,
      () => PROCESS, () => true, undefined, () => null)).toThrow(/session ID is unproven/);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, harness: 'claude', provider: 'anthropic', argv: ['claude', '--model', 'gpt-6-sol'] },
      () => ({ ...PROCESS, argv: ['claude', '--model', 'gpt-6-sol'] }), () => true)).toThrow(/session ID is unproven/);
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
          undefined, status)).toThrow(/session ID is unproven/);
        expect(captureNativeSession(directory, { ...observation, sessionId: OBSERVATION.sessionId },
          observeProcess, () => true, undefined, status).sessionId).toBe(OBSERVATION.sessionId);
      } finally {
        if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
        pty.kill('SIGTERM');
      }
    },
  );
});
