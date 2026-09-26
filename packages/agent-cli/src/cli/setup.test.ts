import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createUnavailableClient } from '../composition/unavailable.js';
import { PATH_HARNESS_IDS, createDiscoveryOnlyAdapter } from '../setup/detect.js';
import { SetupPathError } from '../setup/paths.js';
import { createSetupService, type SetupService } from '../setup/plan.js';
import { decodeSetupResult, type SetupAdapter, type SetupResult } from '../setup/types.js';
import { runCli } from './app.js';
import { setupEnvironment, setupExecute } from './main.js';
import type { CliDependencies } from './types.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function streams() {
  const stdin = new PassThrough(); stdin.end();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ''; let err = '';
  stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
  return { stdin, stdout, stderr, output: () => out, error: () => err };
}

const disconnected = createUnavailableClient();

function result(overrides: Partial<SetupResult>): SetupResult {
  return {
    v: 1, command: 'status', ok: true, changed: false, state: 'no_harness', planDigest: null,
    confirmation: { required: false, confirmed: false }, harnesses: [], operations: [], diagnostics: [], ...overrides,
  };
}

function recordingService(value: SetupResult): SetupService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async configuration() { calls.push(['configuration']); return value; },
    async lifecycle(command, options) { calls.push([command, options]); return { ...value, command }; },
  };
}

async function run(argv: string[], setup?: SetupService) {
  const io = streams();
  const deps: CliDependencies = {
    client: disconnected, inbox: () => { throw new Error('inbox should not be opened'); }, ...io,
    ...(setup === undefined ? {} : { setup }),
  };
  const code = await runCli(argv, deps);
  return { code, stdout: io.output(), stderr: io.error() };
}

describe('setup lifecycle commands', () => {
  it.each([
    ['setup', '--confirm'],
    ['setup', '--confirm', 'sha256:abc'],
    ['setup', '--confirm', DIGEST.toUpperCase()],
    ['remove', '--dry-run', '--confirm', DIGEST],
    ['remove', '--confirm', DIGEST, '--dry-run'],
    ['setup', '--dry-run', '--dry-run'],
    ['setup', '--force'],
    ['remove', 'extra'],
    ['status', '--check', '--check'],
    ['status', '--json'],
  ])('rejects %j before inspecting anything', async (...argv) => {
    const service = recordingService(result({}));
    const outcome = await run(argv, service);
    expect(outcome).toEqual({ code: 2, stdout: '', stderr: '{"ok":false,"error":"invalid_arguments"}\n' });
    expect(service.calls).toEqual([]);
  });

  it('passes dry-run and confirm options through and emits one JSON object with the result exit', async () => {
    const service = recordingService(result({ state: 'confirmation_required', ok: false, planDigest: DIGEST as never }));
    const dry = await run(['setup', '--dry-run'], service);
    const confirmed = await run(['remove', '--confirm', DIGEST], service);
    expect(service.calls).toEqual([
      ['setup', { dryRun: true, confirm: null }],
      ['remove', { dryRun: false, confirm: DIGEST }],
    ]);
    // Exit 5 for a state the frozen exit table maps to confirmation required.
    expect([dry.code, confirmed.code]).toEqual([5, 5]);
    expect(dry.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(dry.stdout)).toMatchObject({ v: 1, command: 'setup' });
  });

  it('maps an invalid HOME to an invalid-input invocation failure', async () => {
    const failing: SetupService = {
      async configuration() { throw new SetupPathError('invalid_home'); },
      async lifecycle() { throw new SetupPathError('invalid_home'); },
    };
    expect(await run(['setup'], failing)).toEqual({ code: 2, stdout: '', stderr: '{"ok":false,"error":"invalid_input"}\n' });
    expect((await run(['status', '--check'], failing)).code).toBe(2);
  });
});

describe('status configuration', () => {
  it('keeps the connection fields and appends configuration', async () => {
    const outcome = await run(['status'], recordingService(result({})));
    expect(outcome.code).toBe(0);
    const { configuration, ...connection } = JSON.parse(outcome.stdout);
    expect(connection).toEqual({ v: 1, connected: false, binding: null, route: 'unavailable', sourceCursor: null, inbox: null });
    expect(decodeSetupResult(configuration).state).toBe('no_harness');
  });

  it.each([
    ['no_harness', 0], ['ready', 0], ['awaiting_hook_review', 3], ['configured_restart_required', 3],
    ['configured_effect_unknown', 3], ['drifted', 3], ['conflict', 3], ['unsupported', 3], ['recovery_required', 4],
  ] as const)('exits 0 bare and %s -> %i with --check', async (state, checkExit) => {
    const service = recordingService(result({ state }));
    expect((await run(['status'], service)).code).toBe(0);
    expect((await run(['status', '--check'], service)).code).toBe(checkExit);
  });
});

describe('production setup composition', () => {
  function snapshot(root: string): string[] {
    const entries: string[] = [];
    const walk = (directory: string) => {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        entries.push(`${file} ${stat.mode} ${stat.mtimeMs} ${stat.isFile() ? fs.readFileSync(file, 'hex') : ''}`);
        if (stat.isDirectory()) walk(file);
      }
    };
    walk(root);
    return entries;
  }

  it('changes nothing on disk across status, dry runs, unconfirmed, and confirmed commands', async () => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-setup-home-'));
    directories.push(home);
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.3 (Claude Code)"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"user":"state"}');
    const before = snapshot(home);
    const env = { HOME: home, PATH: `${bin}:relative` };
    const service = createSetupService({
      environment: () => setupEnvironment(env),
      adapters: PATH_HARNESS_IDS.map(createDiscoveryOnlyAdapter),
      execute: setupExecute(env),
    });

    const status = await run(['status', '--check'], service);
    expect(status.code).toBe(3);
    const configuration = decodeSetupResult(JSON.parse(status.stdout).configuration);
    expect(configuration).toMatchObject({ state: 'unsupported', ok: false });
    expect(configuration.harnesses).toEqual([{ harness: 'claude', executable: { present: true, path: path.join(bin, 'claude') },
      version: { detected: '2.1.3', supported: false }, components: [], route: 'unknown' }]);
    for (const argv of [['status'], ['setup'], ['setup', '--dry-run'], ['remove'], ['remove', '--dry-run'],
      ['setup', '--confirm', DIGEST], ['remove', '--confirm', DIGEST]]) {
      const outcome = await run(argv, service);
      expect(outcome.stderr).toBe('');
      expect(decodeSetupResult(argv[0] === 'status' ? JSON.parse(outcome.stdout).configuration : JSON.parse(outcome.stdout)).changed)
        .toBe(false);
    }
    expect(snapshot(home)).toEqual(before);
  });

  it('reports no harness for an empty synthetic home and PATH', async () => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-setup-empty-'));
    directories.push(home);
    const env = { HOME: home, PATH: '' };
    const service = createSetupService({
      environment: () => setupEnvironment(env),
      adapters: PATH_HARNESS_IDS.map(createDiscoveryOnlyAdapter),
      execute: setupExecute(env),
    });
    for (const command of ['setup', 'remove']) {
      const outcome = await run([command], service);
      expect(outcome.code).toBe(0);
      expect(JSON.parse(outcome.stdout)).toMatchObject({ state: 'no_harness', ok: true, operations: [], planDigest: null });
    }
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('applies a confirmed plan through the transactional executor and never from a dry run', async () => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-setup-apply-'));
    directories.push(home);
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.154.0"\n', { mode: 0o755 });
    const env = { HOME: home, PATH: bin };
    // The executor creates paths below existing XDG roots, as its own fixtures do; it never creates a root.
    for (const root of ['.config', '.local/share', '.local/state']) fs.mkdirSync(path.join(home, root), { recursive: true });
    const marker = path.join(home, '.local', 'share', 'khala', 'versions', 'test', 'marker');
    const bytes = new TextEncoder().encode('khala payload');
    const postimage = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    // A supported test adapter owning one installer file; the real adapters land separately.
    const adapter: SetupAdapter = {
      harness: 'codex',
      async detect(environment) {
        return { ...(await createDiscoveryOnlyAdapter('codex').detect(environment)), supported: true };
      },
      async inspect(environment, detection) {
        const present = (await environment.probe.readFile(marker)) !== null;
        return { detection, components: [{ component: 'payload', state: present ? 'ready' : 'absent' }],
          route: 'native_cli_queue', diagnostics: [] };
      },
      plan(request) {
        const present = request.observation.components.some(component => component.state === 'ready');
        if (request.desired === 'present') {
          return present ? [] : [{ id: 'marker', type: 'file_create', harness: 'codex', component: 'payload', path: marker, postimage }];
        }
        return present ? [{ id: 'marker', type: 'file_delete', harness: 'codex', component: 'payload', path: marker, preimage: postimage }] : [];
      },
    };
    const service = createSetupService({
      environment: () => setupEnvironment(env),
      adapters: [adapter],
      execute: setupExecute(env),
      payload: async () => ({ contents: new Map([[postimage, bytes]]), modes: new Map() }),
    });

    const beforeDryRun = snapshot(home);
    const plan = await run(['setup'], service);
    expect(plan.code).toBe(5);
    const digest = JSON.parse(plan.stdout).planDigest as string;
    const dry = await run(['setup', '--dry-run'], service);
    expect(dry.code).toBe(5);
    expect(snapshot(home)).toEqual(beforeDryRun);

    const applied = await run(['setup', '--confirm', digest], service);
    expect(applied.stderr).toBe('');
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ state: 'ready', ok: true, changed: true,
      operations: [{ id: 'marker', status: 'applied' }] });
    expect(fs.readFileSync(marker, 'utf8')).toBe('khala payload');

    const again = await run(['setup'], service);
    expect(JSON.parse(again.stdout)).toMatchObject({ state: 'ready', changed: false, operations: [] });

    const removal = await run(['remove'], service);
    expect(removal.code).toBe(5);
    const removed = await run(['remove', '--confirm', JSON.parse(removal.stdout).planDigest], service);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ changed: true });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
