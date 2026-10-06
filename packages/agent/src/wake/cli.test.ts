import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runWake } from './cli';
import { stateRoot, sessionFiles } from '../state';
import { readWakeSettings, writeWakeSettings, recordAttempt, settleAttempts, readWakeState } from './shared';
import { wakeDisableNotice, wakeStatus } from './status';
let root: string;
let env: NodeJS.ProcessEnv;
let lines: string[];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-cli-')); env = { XDG_STATE_HOME: root, CODEX_THREAD_ID: 'session' }; lines = []; });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const run = (args: string[]) => runWake(args, { env, stdout: line => lines.push(line), stderr: line => lines.push(line) });
async function disable() {
  const files = sessionFiles('codex', 'session', env);
  for (const [nonce, at] of [['12345678', 100], ['abcdef12', 200]] as const) {
    await recordAttempt(files.dir, { driver: 'terminal', nonce, at, deadline: at + 10 });
    await settleAttempts(files.dir, { now: at + 10, activity: { state: 'idle', updatedAt: 0 } });
  }
  return files;
}
it('lists all harnesses and emits parseable JSON rows and shared text', async () => {
  expect(await run(['status', '--json'])).toBe(0);
  const rows = JSON.parse(lines.pop()!);
  expect(rows.find((row: { harness: string }) => row.harness === 'generic')).toMatchObject({ state: 'none_by_design' });
  expect(rows.find((row: { driver: string }) => row.driver === 'terminal')).toMatchObject({ state: 'needs_consent', remedy: 'khala wake on --driver terminal' });
  await run(['status', '--harness', 'codex']);
  for (const row of await wakeStatus('codex', { env })) expect(lines.at(-1)).toContain(row.reason);
});
it('rejects unknown drivers and harnesses with valid choices and no write', async () => {
  expect(await run(['on', '--harness', 'codex', '--driver', 'bogus'])).toBe(2);
  expect(lines.pop()).toContain('Valid drivers: queue, terminal');
  expect(await run(['status', '--harness', '../escape'])).toBe(2);
  expect(lines.pop()).toContain('Valid harnesses: claude, codex');
  expect(await readWakeSettings(stateRoot(env))).toEqual({ consent: {}, off: {} });
});
it('defaults on to the first opt-in driver, clears disables and pending attempts in every session', async () => {
  const files = await disable();
  await recordAttempt(files.dir, { driver: 'terminal', nonce: 'deadbeef', at: 300, deadline: 310 });
  expect(await run(['on'])).toBe(0);
  expect(lines.pop()).toContain('Idle wake is on (terminal)');
  expect((await readWakeSettings(stateRoot(env))).consent['codex/terminal']).toBeDefined();
  expect(await readWakeState(files.dir)).toEqual({});
  expect(await settleAttempts(files.dir, { now: 500, activity: { state: 'idle', updatedAt: 0 } })).toEqual([]);
  await run(['off', '--harness', 'codex']);
  expect((await wakeStatus('codex', { env, files })).every(row => row.state === 'disabled')).toBe(true);
});
it('claims auto-disable notices once even with simultaneous delivery consumers', async () => {
  const files = await disable();
  const notices = await Promise.all(Array.from({ length: 4 }, () => wakeDisableNotice(files.dir)));
  expect(notices.filter(Boolean)).toHaveLength(1);
  expect(notices.find(Boolean)).toContain('khala wake on --driver terminal');
  expect(JSON.parse(await fs.readFile(path.join(files.dir, 'wake-state.json'), 'utf8')).terminal.noticeShown).toBe(true);
  expect(await wakeDisableNotice(files.dir)).toBeUndefined();
  await run(['on']); await disable();
  expect(await wakeDisableNotice(files.dir)).toContain('terminal');
});
it.each([{ flags: ['--harness'] }, { flags: ['--wat'] }, { flags: ['--driver', '--json'] }])('rejects malformed flags $flags', async ({ flags }) => {
  expect(await run(['status', ...flags])).toBe(2);
});

it('routes the wake command through the shared CLI entry', async () => {
  const { runCli } = await import('../cli');
  const modules = { mcp: () => undefined, local: () => undefined, watch: () => undefined, install: () => undefined, hook: () => undefined,
    wake: () => async () => ({ default: (argv: readonly string[]) => runWake(argv, { env, stdout: line => lines.push(line) }) }) };
  expect(await runCli(['wake', 'status', '--json'], modules)).toBe(0);
  expect(JSON.parse(lines[0]!)).toBeInstanceOf(Array);
});
it('does not infer a synthetic Cursor session outside an agent and makes an unambiguous remedy executable', async () => {
  delete env.CODEX_THREAD_ID;
  expect(await run(['on'])).toBe(2);
  expect(lines.pop()).toContain('Select --harness');
  expect(await run(['on', '--driver', 'terminal'])).toBe(0);
  expect((await readWakeSettings(stateRoot(env))).consent['codex/terminal']).toBeDefined();
  expect(await run(['on', '--driver', 'bogus'])).toBe(2);
  expect(lines.pop()).toContain('Valid drivers: watcher, queue, terminal');
});

it('preserves withdrawal and other harness consent updates across concurrent processes', async () => {
  await writeWakeSettings(stateRoot(env), { consent: { 'claude/watcher': { at: 'before' } }, off: {} });
  const script = path.join(root, 'consent-worker.mjs');
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const harnesses = ['codex', 'cursor', 'gemini', 'qwen'];
  await fs.writeFile(script, `
    const { setWake } = await import(process.argv[2]);
    const env = { XDG_STATE_HOME: process.argv[3] };
    const worker = Number(process.argv[4]);
    process.send('ready');
    await new Promise(resolve => process.once('message', resolve));
    if (worker === 0) await setWake('claude', ['watcher'], false, env);
    for (let index = 0; index < 8; index++) {
      await setWake(process.argv[5], ['driver-' + index], true, env);
    }
    process.disconnect();
  `);
  const workers = harnesses.map((harness, worker) => fork(script, [cli, root, String(worker), harness], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  try {
    const exits = workers.map(child => new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`consent worker exited ${code}: ${stderr}`)));
    }));
    await Promise.all(workers.map(child => new Promise<void>(resolve => child.once('message', () => resolve()))));
    workers.forEach(child => child.send('start'));
    await Promise.all(exits);
    const settings = await readWakeSettings(stateRoot(env));
    expect(settings.consent['claude/watcher']).toBeUndefined();
    expect(settings.off['claude/watcher']).toBeDefined();
    for (const harness of harnesses) {
      for (let index = 0; index < 8; index++) expect(settings.consent[`${harness}/driver-${index}`]).toBeDefined();
    }
  } finally { workers.forEach(child => child.kill()); }
}, 15_000);
