// Private Executor fixture capture: scope, complete observation, and process
// identity must all agree. Agent prose and daemon logs are irrelevant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiurRecords, captureNativeSession, decodeNativeSession, type ProcessSnapshot } from '../../../scripts/acceptance/adapters/aiur';

const OBSERVATION = {
  source: 'executor-native-tmux-fixture', repository: 'aiur-team/khala', runId: '0123456789ab',
  ticket: 1001, role: 'a', sessionId: 'native-7', pid: 4242,
  harness: 'codex', provider: 'openai', model: 'gpt-6-sol', cliVersion: '0.156.1',
  versionOutput: 'codex-cli 0.156.1',
  startedAt: '2026-09-26T10:00:00Z', capturedAt: '2026-09-26T10:01:00Z', processStartTicks: '123456', bootId: 'boot-7',
  executable: '/usr/bin/node', argv: ['codex', '--model', 'gpt-6-sol'], tty: '/dev/pts/7', tmuxPane: '%7',
};
const PROCESS: ProcessSnapshot = {
  pid: 4242, processStartTicks: '123456', bootId: 'boot-7', executable: '/usr/bin/node',
  argv: ['codex', '--model', 'gpt-6-sol'], tty: '/dev/pts/7',
};
const roots: string[] = [];
function root() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-native-')); roots.push(directory); return directory; }
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Executor native fixture evidence', () => {
  it('captures one private scoped native process and reads only its exact run, ticket, and role', async () => {
    const directory = root();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true);
    const port = aiurRecords(directory, 'aiur-team/khala', () => PROCESS, () => true);
    expect((await port.session(1001, OBSERVATION.runId, 'a'))?.sessionId).toBe('native-7');
    expect(await port.session(1002, OBSERVATION.runId, 'a')).toBeNull();
    expect(await port.session(1001, 'ffffffffffff', 'a')).toBeNull();
    expect(await port.session(1001, OBSERVATION.runId, 'b')).toBeNull();
    expect(await aiurRecords(directory, 'foreign/repo', () => PROCESS, () => true).session(1001, OBSERVATION.runId, 'a')).toBeNull();
    expect(await port.alive(decodeNativeSession(OBSERVATION)!)).toBe(true);
    expect(fs.statSync(path.join(directory, Buffer.from('aiur-team/khala').toString('base64url'), OBSERVATION.runId, '1001-a.json')).mode & 0o077).toBe(0);
  });

  it('rejects partial, claimed-only, app-server, and mismatched process observations', () => {
    const directory = root();
    expect(decodeNativeSession({ ...OBSERVATION, model: undefined })).toBeNull();
    expect(decodeNativeSession({ ...OBSERVATION, source: 'worker-prose' })).toBeNull();
    expect(decodeNativeSession({ ...OBSERVATION, argv: ['codex', 'app-server'] })).toBeNull();
    expect(() => captureNativeSession(directory, OBSERVATION, () => ({ ...PROCESS, processStartTicks: '999999' }), () => true)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => ({ ...PROCESS, argv: ['codex', 'app-server'] }), () => true)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => null, () => true)).toThrow();
    expect(() => captureNativeSession(directory, OBSERVATION, () => PROCESS, () => false)).toThrow(/tmux pane/);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, argv: ['node', 'other.js', 'codex', '--model', 'gpt-6-sol'] },
      () => ({ ...PROCESS, argv: ['node', 'other.js', 'codex', '--model', 'gpt-6-sol'] }), () => true)).toThrow(/native harness/);
  });

  it('refuses a second participant for one ticket and PID reuse or death', async () => {
    const directory = root();
    captureNativeSession(directory, OBSERVATION, () => PROCESS, () => true);
    expect(() => captureNativeSession(directory, { ...OBSERVATION, sessionId: 'native-8' }, () => PROCESS, () => true)).toThrow();
    const reused = aiurRecords(directory, 'aiur-team/khala', () => ({ ...PROCESS, processStartTicks: '999999' }), () => true);
    expect(await reused.session(1001, OBSERVATION.runId, 'a')).toBeNull();
    expect(await reused.alive(decodeNativeSession(OBSERVATION)!)).toBe(false);
    expect(await aiurRecords(directory, 'aiur-team/khala', () => null, () => true).session(1001, OBSERVATION.runId, 'a')).toBeNull();
  });

  it('refuses tampered model or CLI version against the native process command and expected profile', () => {
    const directory = root();
    expect(() => captureNativeSession(directory, { ...OBSERVATION, model: 'wrong-model' }, () => PROCESS, () => true)).toThrow();
    expect(decodeNativeSession({ ...OBSERVATION, cliVersion: '' })).toBeNull();
  });
});
